"""Tests for what counts as a username, and how a tag is written.

The atomicity of tag assignment lives in Postgres (migration 0025) and is
checked against the real database separately; these cover the rules this
module owns.
"""

import pytest

from app.services.usernames import InvalidUsername, format_tag, handle, validate


# ---------------------------------------------------------------------------
# Accepted
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("name", ["lucas", "ana.silva", "rui_2", "Lucas", "abc"])
def test_ordinary_names_are_accepted(name):
    assert validate(name) == name


def test_accented_names_are_accepted():
    """People are called João and Inês. A rule that turns their names into
    "Joao" is telling them their name is a typo."""
    assert validate("João") == "João"
    assert validate("inês.m") == "inês.m"


def test_case_is_kept():
    """Case is theirs to choose; only comparison ignores it."""
    assert validate("LucasP") == "LucasP"


def test_surrounding_whitespace_is_trimmed():
    """A trailing space from autocorrect is not a choice anyone made."""
    assert validate("  lucas ") == "lucas"


def test_twenty_characters_is_the_ceiling():
    assert validate("a" * 20) == "a" * 20


# ---------------------------------------------------------------------------
# Refused
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "name",
    [
        "",
        "ab",               # too short
        "a" * 21,           # too long
        "lucas p",          # space
        "lucas!",           # symbol
        "lu@cas",
        "lucas#0001",       # nobody gets to choose their own tag
        ".lucas",           # leading dot
        "lucas.",           # trailing dot
        "lu..cas",          # doubled dot
        "12345",            # digits only read as the tag or a phone number
        "___",              # no letter at all
    ],
)
def test_bad_names_are_refused(name):
    with pytest.raises(InvalidUsername):
        validate(name)


@pytest.mark.parametrize("name", ["admin", "Orbi", "SUPPORT", "moderator"])
def test_names_that_impersonate_the_app_are_reserved(name):
    """A tag cannot fix these: orbi#0001 looks as official as orbi does."""
    with pytest.raises(InvalidUsername):
        validate(name)


def test_the_refusal_is_written_for_a_person():
    with pytest.raises(InvalidUsername) as exc:
        validate("ab")
    assert "at least 3" in str(exc.value)


# ---------------------------------------------------------------------------
# Tags
# ---------------------------------------------------------------------------

def test_tags_are_padded_to_four_digits():
    assert format_tag(1) == "#0001"
    assert format_tag(42) == "#0042"


def test_tags_keep_growing_past_four_digits():
    """Never truncated: the ten-thousandth lucas is lucas#10000, not a
    collision with lucas#0000."""
    assert format_tag(10000) == "#10000"


def test_a_handle_is_name_and_tag():
    assert handle("lucas", 7) == "lucas#0007"


def test_no_handle_until_a_name_is_chosen():
    assert handle(None, None) is None
    assert handle("lucas", None) is None
