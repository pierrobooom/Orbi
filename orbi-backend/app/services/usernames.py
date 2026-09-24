"""Choosing a username, and the tag that makes it unique.

A handle is name#tag — lucas#0001. Many people will want "lucas", so the
name alone identifies nobody; the pair does. Tags are handed out by the
claim_username database function (migration 0025), which is atomic and
never reuses a number. This module decides what counts as a name at all.

WHAT A NAME MAY CONTAIN
Letters in any script, digits, underscore and dot. Letters beyond ASCII
because the people using this app are called João and Inês, and a rule that
turns their names into "Joao" is telling them their name is a typo.

No spaces, no symbols. A handle gets typed, read aloud and pasted into
messages; every character that can be confused with another, or that a
keyboard hides, is a way for two people to believe they mean the same
account when they do not.
"""

from __future__ import annotations

from typing import Final
from uuid import UUID

from app.db.client import get_client

MIN_LENGTH: Final = 3
MAX_LENGTH: Final = 20

# Names that would let someone pass as the app itself. Blocked outright —
# a tag cannot fix these, because "orbi#0001" looks every bit as official
# as "orbi" does.
RESERVED: Final = frozenset(
    {
        "admin",
        "administrator",
        "orbi",
        "support",
        "help",
        "staff",
        "team",
        "official",
        "moderator",
        "mod",
        "system",
        "root",
        "security",
        "null",
        "undefined",
    }
)


class InvalidUsername(ValueError):
    """The name is not acceptable. The message is written for the user."""


def validate(raw: str) -> str:
    """Return the name as it will be stored, or raise InvalidUsername.

    Pure, so the whole rule can be argued about in a test. Surrounding
    whitespace is trimmed — a trailing space from autocorrect is not a
    choice anyone made — but case is kept, because it is theirs.
    """
    name = (raw or "").strip()

    if len(name) < MIN_LENGTH:
        raise InvalidUsername(f"A username needs at least {MIN_LENGTH} characters.")
    if len(name) > MAX_LENGTH:
        raise InvalidUsername(f"A username can be at most {MAX_LENGTH} characters.")

    for char in name:
        if not (char.isalnum() or char in "_."):
            raise InvalidUsername(
                "Use letters, numbers, dots and underscores only."
            )

    # Dots are allowed as separators ("ana.silva"), not as decoration. At
    # either end or doubled, they are nearly invisible when read quickly,
    # which is exactly how two handles come to look identical.
    if name.startswith(".") or name.endswith(".") or ".." in name:
        raise InvalidUsername("Dots can only go between other characters.")

    # A name made only of digits reads as the tag, or as a phone number.
    if not any(char.isalpha() for char in name):
        raise InvalidUsername("A username needs at least one letter.")

    if name.lower() in RESERVED:
        raise InvalidUsername("That name is reserved.")

    return name


def format_tag(tag: int) -> str:
    """#0001 — four digits, and more once there are more than 9999.

    Padded rather than bare so the common case looks deliberate, and never
    truncated: lucas#10000 is simply the ten-thousandth lucas.
    """
    return f"#{tag:04d}"


def handle(name: str | None, tag: int | None) -> str | None:
    """lucas#0001, or None if no name has been chosen yet."""
    if not name or tag is None:
        return None
    return f"{name}{format_tag(tag)}"


async def claim(user_id: UUID, raw: str) -> dict:
    """Validate a name and claim it. Returns {"username", "username_tag"}.

    Raises InvalidUsername before touching the database, so a bad name
    never consumes a tag number.
    """
    name = validate(raw)
    rows = (
        get_client()
        .rpc("claim_username", {"p_user": str(user_id), "p_name": name})
        .execute()
        .data
        or []
    )
    if not rows:
        # The function returns exactly one row for an existing profile. None
        # means the profile row is missing, which signup should have made.
        raise RuntimeError(f"claim_username returned nothing for {user_id}")
    return rows[0]
