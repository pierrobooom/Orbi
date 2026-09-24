"""Tests for what we are willing to accept as a profile picture.

The declared content type is whatever the sender typed. These tests are
about the only claim a sender cannot fake: the bytes themselves.
"""

import pytest

from app.services.avatars import InvalidImage, _path_within_bucket, sniff

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 16
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
GIF = b"GIF89a" + b"\x00" * 16
WEBP = b"RIFF" + b"\x24\x00\x00\x00" + b"WEBP" + b"\x00" * 16
HEIC = b"\x00\x00\x00\x18" + b"ftyp" + b"heic" + b"\x00" * 16


# ---------------------------------------------------------------------------
# What we accept
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "data,extension,content_type",
    [
        (JPEG, "jpg", "image/jpeg"),
        (PNG, "png", "image/png"),
        (GIF, "gif", "image/gif"),
        (WEBP, "webp", "image/webp"),
        (HEIC, "heic", "image/heic"),
    ],
)
def test_known_image_formats_are_recognised(data, extension, content_type):
    assert sniff(data) == (extension, content_type)


def test_heic_is_accepted_because_it_is_what_an_iphone_produces():
    """Rejecting HEIC would reject the default camera format on iOS, which
    to the user looks like the picker simply not working."""
    assert sniff(HEIC)[0] == "heic"


# ---------------------------------------------------------------------------
# What we refuse
# ---------------------------------------------------------------------------

def test_a_riff_container_that_is_not_webp_is_refused():
    """WAV starts with the same four bytes as WebP. Checking only the first
    four would accept audio, and anything else wearing a RIFF header."""
    wav = b"RIFF" + b"\x24\x00\x00\x00" + b"WAVE" + b"\x00" * 16
    with pytest.raises(InvalidImage):
        sniff(wav)


def test_an_executable_is_refused():
    with pytest.raises(InvalidImage):
        sniff(b"MZ\x90\x00" + b"\x00" * 32)


def test_a_script_is_refused_however_it_is_named():
    with pytest.raises(InvalidImage):
        sniff(b"<?php system($_GET['c']); ?>" + b"\x00" * 16)


def test_an_svg_is_refused():
    """SVG is an image, and also a document that can carry script. A public
    bucket serving one is a stored-XSS vector, so it is not on the list."""
    with pytest.raises(InvalidImage):
        sniff(b"<svg xmlns='http://www.w3.org/2000/svg'></svg>")


def test_something_shorter_than_a_header_is_refused_not_crashed():
    with pytest.raises(InvalidImage):
        sniff(b"\xff\xd8")


def test_empty_input_is_refused():
    with pytest.raises(InvalidImage):
        sniff(b"")


# ---------------------------------------------------------------------------
# Deleting only ever touches our own objects
# ---------------------------------------------------------------------------

def test_the_object_name_is_recovered_from_our_own_url():
    url = "https://x.supabase.co/storage/v1/object/public/avatars/user-1/abc.jpg"
    assert _path_within_bucket(url) == "user-1/abc.jpg"


def test_a_cache_busting_query_is_not_part_of_the_name():
    url = "https://x.supabase.co/storage/v1/object/public/avatars/user-1/abc.jpg?v=2"
    assert _path_within_bucket(url) == "user-1/abc.jpg"


def test_a_url_from_somewhere_else_yields_nothing_to_delete():
    """A profile pointing at an unrelated URL must not make us try to parse
    a path out of it and delete whatever we guessed."""
    assert _path_within_bucket("https://example.com/someone/else.jpg") is None


def test_no_url_is_not_an_error():
    assert _path_within_bucket("") is None
