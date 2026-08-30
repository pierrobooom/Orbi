"""Redaction helpers for anything user-spoken that reaches a log.

CLAUDE.md, Security Rules: "Never log full user transcripts in production."
The diagnostic logs around parsing are genuinely valuable — reproducing a
bad parse without the transcript is close to impossible — so the answer
is not to delete them but to make them environment-aware.

In development the transcript is logged verbatim. In staging and
production it is reduced to a length and a short prefix: enough to tell
"the parse got a long utterance" or "the transcript was empty" apart,
without retaining what the user actually said.
"""

import os

_ENVIRONMENT = os.environ.get("ENVIRONMENT", "development").strip().lower()

# Only development gets verbatim transcripts. Anything unrecognised is
# treated as production — the safe direction to fail in for a privacy
# control.
_IS_DEVELOPMENT = _ENVIRONMENT == "development"

# Enough to recognise a capture you just made while testing staging,
# far too little to reconstruct what someone said.
_PREFIX_CHARS = 12


def safe_transcript(text: str | None) -> str:
    """Return the transcript for logging, redacted outside development."""
    if text is None:
        return "<none>"
    if _IS_DEVELOPMENT:
        return repr(text)
    stripped = text.strip()
    if not stripped:
        return "<empty>"
    return f"<{len(stripped)} chars: {stripped[:_PREFIX_CHARS]!r}…>"


def is_development() -> bool:
    """True when verbatim user content may be logged."""
    return _IS_DEVELOPMENT
