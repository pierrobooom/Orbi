"""Shared utilities for agents that parse LLM JSON output.

Some LLMs (notably Groq's Llama family) reliably wrap their JSON
responses in markdown code fences (```json ... ```), which makes
json.loads fail because the first character is a backtick. Stripping
fences before parsing is safe even when the raw response is bare JSON.
"""

import re

# Matches the FIRST fenced block anywhere in the response. The LLM
# sometimes prepends prose ("## Intent Classification\n\n```json...```"),
# so we can't anchor the regex to the start of the string.
_FENCED_BLOCK = re.compile(
    r"```(?:json|JSON)?\s*\n?(.*?)\n?```",
    re.DOTALL,
)


def strip_json_fences(raw: str) -> str:
    """Return the JSON content from inside ```json ... ``` fences.

    Tolerant of:
      - Prose before the fence ("## Intent Classification\n\n```json...```")
      - Prose after the fence
      - Bare JSON with no fence at all
      - Partial fences (opening only, closing only)
    """
    if not raw:
        return raw
    match = _FENCED_BLOCK.search(raw)
    if match:
        return match.group(1).strip()
    # No complete fenced block. Try to salvage a partial one — opening
    # fence but no close, or close but no open.
    stripped = raw.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        return "\n".join(lines).strip()
    return stripped
