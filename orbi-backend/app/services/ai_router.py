import logging
import os
import time
from pathlib import Path

import anthropic
from groq import Groq

logger = logging.getLogger(__name__)

_groq_client = Groq(api_key=os.environ["GROQ_API_KEY"])
_anthropic_client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

_GROQ_MODEL = "llama-3.1-8b-instant"
_CLAUDE_MODEL = "claude-sonnet-4-6"

_PROMPTS_DIR = Path(__file__).parent.parent / "prompts"

_FALLBACK_RESPONSE = (
    "I'm having trouble processing that right now. Please try again in a moment."
)


def load_prompt(agent_name: str, version: int = 1) -> str:
    """Load a prompt template from app/prompts/.

    Prompt files follow the naming convention: {agent_name}_v{version}.md

    Args:
        agent_name: Name of the agent, e.g. "task_parser" or "finance_agent".
        version:    Integer version number. Defaults to 1.

    Returns:
        The full prompt text as a string.

    Raises:
        FileNotFoundError: If no matching prompt file exists in app/prompts/.
    """
    file_name = f"{agent_name}_v{version}.md"
    prompt_path = _PROMPTS_DIR / file_name

    if not prompt_path.exists():
        raise FileNotFoundError(
            f"Prompt file not found: {prompt_path}. "
            f"Expected a file named '{file_name}' in app/prompts/."
        )

    return prompt_path.read_text(encoding="utf-8")


async def get_ai_response(
    prompt: str,
    user_tier: str,
    system_prompt: str,
    max_tokens: int = 500,
) -> str:
    """Route an AI request to the correct provider based on the user's subscription tier.

    Premium users are served by Claude Sonnet 4.6 (Anthropic).
    Free and Pro users are served by Llama 3.1 8B (Groq).

    This function never raises. If the provider call fails, a safe fallback
    string is returned and the error is logged server-side.

    Args:
        prompt:        The user-facing message or extracted intent to send.
        user_tier:     Subscription tier — "free", "pro", or "premium".
        system_prompt: Instruction context prepended before the user message.
        max_tokens:    Maximum tokens in the model response. Defaults to 500.

    Returns:
        The model's response text, or a fallback string on failure.
    """
    if user_tier == "premium":
        return await _call_claude(prompt, system_prompt, max_tokens)
    else:
        # Covers "free" and "pro" — Groq handles both tiers
        return await _call_groq(prompt, system_prompt, max_tokens)


async def _call_groq(prompt: str, system_prompt: str, max_tokens: int) -> str:
    """Call Groq's Llama 3.1 8B and return the response text.

    Used for free and pro tier users. Groq's low-latency inference keeps
    costs near $0.001/user/day at expected usage volumes.
    """
    start_ms = time.monotonic()
    try:
        response = _groq_client.chat.completions.create(
            model=_GROQ_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ],
            max_tokens=max_tokens,
        )
        elapsed_ms = int((time.monotonic() - start_ms) * 1000)
        result = response.choices[0].message.content or _FALLBACK_RESPONSE

        logger.info(
            "AI call completed | provider=groq model=%s tier=free/pro "
            "tokens_used=%s latency_ms=%d",
            _GROQ_MODEL,
            response.usage.total_tokens if response.usage else "unknown",
            elapsed_ms,
        )
        return result

    except Exception as exc:
        elapsed_ms = int((time.monotonic() - start_ms) * 1000)
        logger.error(
            "Groq call failed | model=%s latency_ms=%d error=%s",
            _GROQ_MODEL,
            elapsed_ms,
            exc,
        )
        return _FALLBACK_RESPONSE


async def _call_claude(prompt: str, system_prompt: str, max_tokens: int) -> str:
    """Call Claude Sonnet 4.6 via the Anthropic API and return the response text.

    Reserved for premium tier users only. Claude handles deep reasoning,
    long memory synthesis, and complex multi-step agent tasks.
    """
    start_ms = time.monotonic()
    try:
        response = _anthropic_client.messages.create(
            model=_CLAUDE_MODEL,
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
            _CLAUDE_MODEL,
            response.usage.input_tokens,
            response.usage.output_tokens,
            elapsed_ms,
        )
        return result

    except Exception as exc:
        elapsed_ms = int((time.monotonic() - start_ms) * 1000)
        logger.error(
            "Anthropic call failed | model=%s latency_ms=%d error=%s",
            _CLAUDE_MODEL,
            elapsed_ms,
            exc,
        )
        return _FALLBACK_RESPONSE
