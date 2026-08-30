"""AI provider router with per-tier quotas and intent-aware model selection.

Every AI call in Orbi goes through this module. It is the single chokepoint
that enforces:

1. Tier-correct model selection
       Spark   (free)    -> Llama 3.1 8B
       Pro                -> Llama 3.1 70B
       Genius  (premium) -> Llama 3.1 70B for daily chat,
                            Claude Sonnet 4.6 for premium intents
                            (debrief, weekly_review, monthly_synthesis).

2. Daily ai_turn quota (CLAUDE.md per-tier caps).

3. Monthly claude_call quota (Genius only, 100/month).

4. Per-call structured logging (provider, model, tokens, tier, latency).

If the user has no quota left, the function returns a friendly message
naming the cap and reset window — no provider call is made.

Internal tier values stay 'free' / 'pro' / 'premium' (CLAUDE.md). Marketing
names (Spark / Pro / Genius) only appear in user-facing messages.
"""

import logging
import re
import os
import time
from pathlib import Path
from uuid import UUID

import anthropic
import groq
from groq import Groq

from app.services.usage_tracker import QuotaExceeded, check_and_record

logger = logging.getLogger(__name__)

_groq_client = Groq(api_key=os.environ["GROQ_API_KEY"])
_anthropic_client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

# Two GPT-OSS variants — Spark uses the cheap 20B, paid tiers use the bigger
# 120B for daily chat. Claude is reserved for Genius's premium intents only.
#
# These replaced llama-3.1-8b-instant / llama-3.1-70b-versatile, which Groq
# retired: every call 404'd with model_not_found. Because get_ai_response
# swallows provider errors and returns _FALLBACK_RESPONSE, the outage showed
# up downstream as "coordinator failed to parse AI response" rather than as a
# model error — worth remembering the next time parsing mysteriously breaks.
#
# Both GPT-OSS models advertise json_mode AND structured_outputs, which the
# coordinator and task_parser rely on to get parseable JSON back. Qwen was
# the other candidate but offers json_mode only, at 4-5x the price.
_GROQ_MODEL_SMALL = "openai/gpt-oss-20b"
_GROQ_MODEL_LARGE = "openai/gpt-oss-120b"
_CLAUDE_MODEL = "claude-sonnet-4-6"

# Intents that are eligible for Claude on the Genius tier. Anything else —
# even from a Genius user — runs on Llama 70B. This keeps daily chat off
# Claude's $3/$15-per-million-token meter.
_CLAUDE_INTENTS = {"debrief", "weekly_review", "monthly_synthesis"}

_PROMPTS_DIR = Path(__file__).parent.parent / "prompts"

_FALLBACK_RESPONSE = (
    "I'm having trouble processing that right now. Please try again in a moment."
)


class AIRateLimited(Exception):
    """The provider rejected the call for rate limiting, not for being wrong.

    This is the ONE provider failure that gets its own exception rather
    than collapsing into _FALLBACK_RESPONSE. A rate limit is transient and
    the user can act on it ("wait a few seconds"); every other provider
    error is opaque to them.

    It also removes a genuinely confusing failure mode: the fallback
    string is not JSON, so an agent that parses the reply reports
    "failed to parse AI response" — which is what a DEAD MODEL looks like.
    Groq's free tier allows 8,000 tokens/minute and the coordinator prompt
    is a large fraction of that, so two quick voice commands can trip it.
    Debugging that as a parser bug is a trap worth closing permanently.
    """

    def __init__(self, message: str, retry_after_seconds: float | None = None):
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds


def _retry_after_from(exc: Exception) -> float | None:
    """Pull a retry delay out of a provider error when it offers one.

    Groq puts "Please try again in 8.145s" in the message and also sends a
    retry-after header; the header is authoritative when present.
    """
    response = getattr(exc, "response", None)
    header = None
    if response is not None:
        try:
            header = response.headers.get("retry-after")
        except Exception:  # noqa: BLE001 — header access is best-effort
            header = None
    if header:
        try:
            return float(header)
        except (TypeError, ValueError):
            pass
    match = re.search(r"try again in ([\d.]+)s", str(exc))
    return float(match.group(1)) if match else None


def load_prompt(agent_name: str, version: int = 1) -> str:
    """Load a prompt template from app/prompts/.

    Prompt files follow the naming convention: {agent_name}_v{version}.md
    """
    file_name = f"{agent_name}_v{version}.md"
    prompt_path = _PROMPTS_DIR / file_name

    if not prompt_path.exists():
        raise FileNotFoundError(
            f"Prompt file not found: {prompt_path}. "
            f"Expected a file named '{file_name}' in app/prompts/."
        )

    return prompt_path.read_text(encoding="utf-8")


def _resolve_provider(user_tier: str, intent: str) -> tuple[str, str]:
    """Return (provider, model) for this tier+intent combination.

    Provider is 'groq' or 'anthropic'. Claude is only used when the tier is
    premium (Genius) AND the intent is in _CLAUDE_INTENTS. Every other case
    routes to Llama on Groq, with the model size depending on tier.
    """
    if user_tier == "premium" and intent in _CLAUDE_INTENTS:
        return "anthropic", _CLAUDE_MODEL
    if user_tier in {"pro", "premium"}:
        return "groq", _GROQ_MODEL_LARGE
    return "groq", _GROQ_MODEL_SMALL


async def get_ai_response(
    prompt: str,
    user_id: UUID,
    user_tier: str,
    system_prompt: str,
    intent: str = "daily_chat",
    max_tokens: int = 500,
) -> str:
    """Route an AI request, enforce quotas, and return the model's reply.

    The caller passes the authenticated user_id and an `intent` describing
    what kind of work this is. Intent drives both the cap (claude_call only
    counts when Claude is actually used) and the provider choice.

    Never raises. Quota exhaustion returns a user-safe explanation of which
    cap was hit and when it resets. Provider errors return a generic fallback.

    Args:
        prompt:        The user-facing message or extracted intent.
        user_id:       Authenticated user — used for quota tracking.
        user_tier:     DB tier value — 'free', 'pro', or 'premium'.
        system_prompt: Instruction context prepended to the user message.
        intent:        Why we are calling the AI. 'daily_chat' for routine
                       chat; 'debrief' / 'weekly_review' / 'monthly_synthesis'
                       for Claude-eligible Genius intents. Defaults to
                       daily_chat so back-compat callers cannot accidentally
                       reach Claude.
        max_tokens:    Maximum tokens in the model response.

    Returns:
        Model response text, a quota message, or a fallback string.
    """
    provider, model = _resolve_provider(user_tier, intent)

    # Daily ai_turn cap covers every chat call regardless of provider.
    try:
        await check_and_record(user_id, user_tier, "ai_turn")
    except QuotaExceeded as exc:
        logger.info("ai_turn quota hit | user=%s tier=%s", user_id, user_tier)
        return str(exc)

    # Genius's separate monthly Claude cap. Only counted when actually using
    # Claude — a Genius user on daily_chat does not burn this meter.
    if provider == "anthropic":
        try:
            await check_and_record(user_id, user_tier, "claude_call")
        except QuotaExceeded as exc:
            logger.info("claude_call quota hit | user=%s", user_id)
            return str(exc)

    if provider == "anthropic":
        return await _call_claude(prompt, system_prompt, max_tokens, model)
    return await _call_groq(prompt, system_prompt, max_tokens, model, user_tier)


async def _call_groq(
    prompt: str,
    system_prompt: str,
    max_tokens: int,
    model: str,
    user_tier: str,
) -> str:
    """Call Groq and return the response text.

    reasoning_effort="low" is not optional here. The GPT-OSS models are
    reasoning models: they spend completion tokens on a hidden reasoning
    pass before emitting any content, and that reasoning is billed against
    the same max_tokens budget. At the default effort a 100-token budget
    (finance_agent's merchant categoriser) is consumed entirely by reasoning
    and `content` comes back as an empty string — which _FALLBACK_RESPONSE
    then masks as a generic failure. "low" keeps a trivial categorisation at
    ~34 completion tokens, leaving every existing caller's budget workable.
    """
    start_ms = time.monotonic()
    try:
        response = _groq_client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ],
            max_tokens=max_tokens,
            # Passed via extra_body because groq-python 0.9.0 predates the
            # parameter and rejects it as an unexpected kwarg. extra_body
            # goes straight into the request JSON, so it works today and
            # stays correct after an SDK upgrade.
            extra_body={"reasoning_effort": "low"},
        )
        elapsed_ms = int((time.monotonic() - start_ms) * 1000)
        result = response.choices[0].message.content or _FALLBACK_RESPONSE

        logger.info(
            "AI call completed | provider=groq model=%s tier=%s "
            "tokens_used=%s latency_ms=%d",
            model,
            user_tier,
            response.usage.total_tokens if response.usage else "unknown",
            elapsed_ms,
        )
        return result

    except groq.RateLimitError as exc:
        elapsed_ms = int((time.monotonic() - start_ms) * 1000)
        logger.warning(
            "Groq rate limited | model=%s latency_ms=%d error=%s",
            model, elapsed_ms, exc,
        )
        raise AIRateLimited(
            "Too many requests in a row. Wait a few seconds and try again.",
            retry_after_seconds=_retry_after_from(exc),
        ) from exc

    except Exception as exc:
        elapsed_ms = int((time.monotonic() - start_ms) * 1000)
        logger.error(
            "Groq call failed | model=%s latency_ms=%d error=%s",
            model, elapsed_ms, exc,
        )
        return _FALLBACK_RESPONSE


async def _call_claude(
    prompt: str,
    system_prompt: str,
    max_tokens: int,
    model: str,
) -> str:
    """Call Claude Sonnet via the Anthropic API and return the response text."""
    start_ms = time.monotonic()
    try:
        response = _anthropic_client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system_prompt,
            messages=[
                {"role": "user", "content": prompt},
            ],
        )
        elapsed_ms = int((time.monotonic() - start_ms) * 1000)
        result = response.content[0].text if response.content else _FALLBACK_RESPONSE

        logger.info(
            "AI call completed | provider=anthropic model=%s tier=premium "
            "input_tokens=%d output_tokens=%d latency_ms=%d",
            model,
            response.usage.input_tokens,
            response.usage.output_tokens,
            elapsed_ms,
        )
        return result

    except anthropic.RateLimitError as exc:
        elapsed_ms = int((time.monotonic() - start_ms) * 1000)
        logger.warning(
            "Anthropic rate limited | model=%s latency_ms=%d error=%s",
            model, elapsed_ms, exc,
        )
        raise AIRateLimited(
            "Too many requests in a row. Wait a few seconds and try again.",
            retry_after_seconds=_retry_after_from(exc),
        ) from exc

    except Exception as exc:
        elapsed_ms = int((time.monotonic() - start_ms) * 1000)
        logger.error(
            "Anthropic call failed | model=%s latency_ms=%d error=%s",
            model, elapsed_ms, exc,
        )
        return _FALLBACK_RESPONSE
