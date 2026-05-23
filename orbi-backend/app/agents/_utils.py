"""Shared utilities for agents that parse LLM JSON output.

Some LLMs (notably Groq's Llama family) reliably wrap their JSON
responses in markdown code fences (```json ... ```), which makes
json.loads fail because the first character is a backtick. Stripping
fences before parsing is safe even when the raw response is bare JSON.
"""

import re

# Matches a complete fenced block: optional language hint after the
# opening ```, content, then closing ```. DOTALL so . matches newlines.
_FENCED_BLOCK = re.compile(
    r"^\s*```(?:json|JSON)?\s*\n?(.*?)\n?```\s*$",
    re.DOTALL,
)


def strip_json_fences(raw: str) -> str:
    """Return raw with any surrounding ```json ... ``` fences removed.

    Defensive — returns the trimmed input unchanged if there's no fence.
    """
    if not raw:
        return raw
    match = _FENCED_BLOCK.match(raw)
    if match:
        return match.group(1).strip()
    # Fallback for partial fences (e.g. trailing ``` only). Walk the
    # first and last lines and trim if they look like fence markers.
    stripped = raw.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        return "\n".join(lines).strip()
    return stripped
