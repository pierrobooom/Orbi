"""Tests for spoken-time extraction.

The regression that prompted most of this: "Daqui a 10 minutos tem que ir
tomar banho", said at 22:12 Lisbon, stored a deadline of 09:00 UTC — the
same morning, eleven hours in the past. Two independent faults combined.
The preposition alternation matched the bare "a" in "daqui a 10", reading
it as ten o'clock, and nothing in the module understood relative offsets
at all, so the rest fell through to the model's arithmetic.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.services.time_extractor import (
    extract_local_clock,
    extract_relative_offset,
    override_due_at_relative,
)

UTC = timezone.utc
PT = "pt-PT"
EN = "en-GB"


# ---------------------------------------------------------------------------
# The bare-"a" false positive
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "transcript",
    [
        "Daqui a 10 minutos tem que ir tomar banho",
        "daqui a 10 minutos",
        "dentro de 2 horas",
        "preciso de ligar a 3 pessoas",
        "enviar a 5 clientes",
    ],
)
def test_a_plus_number_is_not_a_clock_time(transcript):
    """"a" followed by a number is not a time. It used to be read as one,
    which is how a shower due at 22:22 became 10:00."""
    assert extract_local_clock(transcript, language=PT) is None


@pytest.mark.parametrize(
    "transcript,expected",
    [
        ("às 8 da noite", (20, 0)),
        ("as 20", (20, 0)),
        ("às 22:22", (22, 22)),
        ("às oito da noite", (20, 0)),
        ("à uma da tarde", (13, 0)),
        ("20h30", (20, 30)),
        ("das 9 da manhã", (9, 0)),
        ("pelas 9", (9, 0)),
        ("meio-dia", (12, 0)),
        ("às oito e meia", (8, 30)),
    ],
)
def test_real_portuguese_clock_phrases_still_work(transcript, expected):
    """Dropping the bare "a" must not cost any genuine phrasing."""
    assert extract_local_clock(transcript, language=PT) == expected


# ---------------------------------------------------------------------------
# Relative offsets
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "transcript,expected",
    [
        ("daqui a 10 minutos", timedelta(minutes=10)),
        ("Daqui a 10 minutos tem que ir tomar banho", timedelta(minutes=10)),
        ("dentro de 2 horas", timedelta(hours=2)),
        ("dentro de duas horas", timedelta(hours=2)),
        ("em 30 minutos", timedelta(minutes=30)),
        ("daqui a uma hora", timedelta(hours=1)),
        ("daqui a meia hora", timedelta(minutes=30)),
        ("daqui a 3 dias", timedelta(days=3)),
        ("dentro de 2 semanas", timedelta(weeks=2)),
    ],
)
def test_portuguese_relative_offsets(transcript, expected):
    assert extract_relative_offset(transcript, language=PT) == expected


@pytest.mark.parametrize(
    "transcript,expected",
    [
        ("in 10 minutes", timedelta(minutes=10)),
        ("remind me in 2 hours", timedelta(hours=2)),
        ("in two hours", timedelta(hours=2)),
        ("in half an hour", timedelta(minutes=30)),
        ("in 3 days", timedelta(days=3)),
        ("in a week", timedelta(weeks=1)),
    ],
)
def test_english_relative_offsets(transcript, expected):
    assert extract_relative_offset(transcript, language=EN) == expected


def test_offset_found_even_when_the_language_tag_is_wrong():
    """Transcripts mix languages, and the tag is only ever a hint."""
    assert extract_relative_offset("in 10 minutes", language=PT) == timedelta(minutes=10)
    assert extract_relative_offset("daqui a 10 minutos", language=EN) == timedelta(minutes=10)


@pytest.mark.parametrize(
    "transcript",
    [
        "a reunião demora 30 minutos",
        "o filme tem 2 horas",
        "comprar leite",
        "",
    ],
)
def test_duration_without_a_lead_in_is_not_a_deadline(transcript):
    """"the meeting takes 30 minutes" says how long it lasts, not when it
    is due. The lead-in ("daqui a", "dentro de", "in") is what makes an
    offset a deadline."""
    assert extract_relative_offset(transcript, language=PT) is None


def test_implausible_offsets_are_rejected():
    """A mis-transcribed "999 weeks" would otherwise land a task 19 years
    out, past every sanity check downstream."""
    assert extract_relative_offset("daqui a 999 semanas", language=PT) is None


# ---------------------------------------------------------------------------
# The override, end to end
# ---------------------------------------------------------------------------

def test_relative_override_replaces_the_models_answer_entirely():
    """The original bug, reproduced: said at 22:12 Lisbon (21:12 UTC), the
    model answered 09:00 the same morning. The offset must win."""
    now = datetime(2026, 9, 18, 21, 12, tzinfo=UTC)
    result, handled = override_due_at_relative(
        "2026-09-18T09:00:00Z",
        "Daqui a 10 minutos tem que ir tomar banho",
        language=PT,
        now=now,
    )
    assert handled is True
    assert result == "2026-09-18T21:22:00Z"


def test_relative_override_leaves_other_phrasings_alone():
    """No offset means the weekday and clock passes must still run, so
    `handled` has to be False rather than merely returning the input."""
    result, handled = override_due_at_relative(
        "2026-09-20T15:00:00Z", "na próxima segunda às 9", language=PT
    )
    assert handled is False
    assert result == "2026-09-20T15:00:00Z"


def test_relative_override_drops_seconds():
    now = datetime(2026, 9, 18, 21, 12, 37, 500000, tzinfo=UTC)
    result, _ = override_due_at_relative(None, "in 5 minutes", language=EN, now=now)
    assert result == "2026-09-18T21:17:00Z"


def test_relative_override_works_with_no_model_answer_at_all():
    """The offset is self-sufficient: it needs no date from the model."""
    now = datetime(2026, 9, 18, 21, 12, tzinfo=UTC)
    result, handled = override_due_at_relative(None, "daqui a 2 horas", language=PT, now=now)
    assert handled is True
    assert result == "2026-09-18T23:12:00Z"
