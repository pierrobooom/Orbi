"""Keep prompts inside a token budget without making them stupid.

The problem
-----------
Several agents serialised whole database rows straight into a prompt:

    f"CLUSTERS:\\n{json.dumps(clusters, indent=2)}\\n\\n"
    f"TASKS:\\n{json.dumps(tasks, indent=2)}"

Nothing bounded that. At a dozen tasks it's fine; at the Pro tier's 500
it is tens of thousands of tokens, which blows past both Groq's
free-tier 8,000 tokens/minute and eventually the model's context window.
The failure is also silent-ish — a rate limit used to come back as the
generic fallback string, which then failed to parse as JSON and looked
like a broken prompt.

The approach
------------
Two independent savings, applied in this order:

1. **Field-strip** every record down to what the prompt actually reasons
   about. A task row carries ~18 columns; the clustering prompt needs
   four. This is the big win and it costs nothing in quality — the model
   never saw `urgency_score` or `embedding_source` as useful signal.
2. **Cap** the number of records, keeping the most relevant. Truncation
   is last resort and is always announced to the model ("... and 40
   more"), because silently showing 20 of 60 tasks invites confident
   statements about a set the model cannot see.

Token counting is deliberately an estimate (chars/4) rather than a real
tokeniser. tiktoken is a 2MB+ dependency, is wrong for non-OpenAI models
anyway, and this only needs to be right to within ~20% to keep us off a
hard limit. Erring high is safe; erring low costs a 429.
"""

from typing import Any, Iterable, Sequence

# Average characters per token for English and Portuguese prose plus
# JSON punctuation. Real tokenisers land between 3.5 and 4.5 for this
# kind of content; 4.0 is a fair middle with a bias toward caution.
_CHARS_PER_TOKEN = 4.0


def estimate_tokens(text: str) -> int:
    """Rough token count. Cheap, dependency-free, deliberately approximate."""
    if not text:
        return 0
    return int(len(text) / _CHARS_PER_TOKEN) + 1


def fit_history(
    messages: Sequence[dict],
    *,
    max_tokens: int,
    max_messages: int | None = None,
) -> list[dict]:
    """Trim conversation history to a token budget, newest first.

    Recency beats completeness in a chat context: the last exchange is
    what the user is referring to. Messages are taken from the end and
    the result is returned in original order.

    A single message longer than the whole budget is kept and truncated
    rather than dropped — dropping the user's most recent turn would be
    worse than showing part of it.
    """
    if not messages:
        return []

    ordered = list(messages)
    if max_messages is not None:
        ordered = ordered[-max_messages:]

    kept: list[dict] = []
    used = 0
    for message in reversed(ordered):
        content = str(message.get("content") or "")
        cost = estimate_tokens(content) + 4  # role + framing overhead
        if used + cost > max_tokens:
            if not kept:
                # Never return nothing: truncate the newest message.
                allowance = max(0, max_tokens - 4)
                chars = int(allowance * _CHARS_PER_TOKEN)
                trimmed = dict(message)
                trimmed["content"] = content[:chars]
                kept.append(trimmed)
            break
        kept.append(dict(message))
        used += cost
    kept.reverse()
    return kept


def strip_fields(
    records: Iterable[dict],
    fields: Sequence[str],
    *,
    drop_empty: bool = True,
) -> list[dict]:
    """Keep only `fields` from each record.

    drop_empty removes None/""/[] values afterwards, because
    `"description": null` costs tokens to say nothing. Field order is
    preserved so the serialised output stays stable and diffable.
    """
    out: list[dict] = []
    for record in records:
        slim = {}
        for field in fields:
            if field not in record:
                continue
            value = record[field]
            if drop_empty and (value is None or value == "" or value == []):
                continue
            slim[field] = value
        out.append(slim)
    return out


def fit_records(
    records: Sequence[dict],
    fields: Sequence[str],
    *,
    max_tokens: int,
    max_records: int | None = None,
) -> tuple[list[dict], int]:
    """Field-strip and cap a record list to a budget.

    Returns (kept, omitted_count). The caller is expected to tell the
    model about `omitted_count` — see render_records, which does it.

    Records are kept in the order given, so callers should pass them
    already sorted by whatever "most relevant" means for that prompt
    (pressure, due date, recency).
    """
    slim = strip_fields(records, fields)
    if max_records is not None:
        omitted_by_count = max(0, len(slim) - max_records)
        slim = slim[:max_records]
    else:
        omitted_by_count = 0

    kept: list[dict] = []
    used = 0
    for record in slim:
        # +2 for the comma and newline this record adds to the array.
        cost = estimate_tokens(_compact_json(record)) + 2
        if used + cost > max_tokens:
            break
        kept.append(record)
        used += cost

    omitted = omitted_by_count + (len(slim) - len(kept))
    return kept, omitted


def _compact_json(value: Any) -> str:
    """JSON with no cosmetic whitespace.

    indent=2 was costing roughly a third of the payload on the
    auto-organise prompt for zero benefit — the model does not read more
    accurately for being pretty-printed.
    """
    import json

    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, default=str)


def render_records(
    records: Sequence[dict],
    fields: Sequence[str],
    *,
    max_tokens: int,
    max_records: int | None = None,
    label: str = "records",
) -> str:
    """Serialise records for a prompt, disclosing anything omitted.

    The disclosure matters: a model shown 20 of 60 tasks with no note
    will happily conclude "you have 20 tasks". Telling it the set is
    partial is the difference between a truncated prompt and a wrong
    answer.
    """
    kept, omitted = fit_records(
        records, fields, max_tokens=max_tokens, max_records=max_records
    )
    body = _compact_json(kept)
    if omitted > 0:
        return f"{body}\n({omitted} more {label} not shown — this list is partial.)"
    return body
