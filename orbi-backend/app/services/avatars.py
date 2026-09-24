"""Storing a profile picture, and throwing away the one it replaces.

WHERE THE BYTES GO
Supabase Storage, public bucket "avatars", under a random object name. The
database keeps only the URL — see migration 0024 for why the image itself
does not belong in a row that is read on nearly every request.

WHY THE UPLOAD GOES THROUGH US AND NOT STRAIGHT TO STORAGE
The client could talk to Storage directly with the anon key, but then the
rules about what may be uploaded would live in storage policies, written in
a different language, in a different place, enforced by a service the app
never otherwise touches. Here, the same dependency that authenticates every
other request authenticates this one, and the limits below are ordinary
Python anyone reading this file can see.

WHAT IS ACTUALLY CHECKED
The declared content type is not trusted. A file is accepted because its
first bytes look like an image we know, which is the only claim about a
file that the sender does not get to make up. Size is capped before that,
because reading an unbounded upload into memory to sniff it is how a phone
with a 40MB photo becomes a server incident.

Both limits are enforced on the bucket too. That is deliberate duplication:
this module is the friendly error, the bucket is the one that holds even if
this code is later called from somewhere that forgets to check.
"""

import logging
import uuid
from typing import Final
from uuid import UUID

from app.db.client import get_client

logger = logging.getLogger(__name__)

BUCKET: Final = "avatars"

# 5 MB. A profile picture that survives being cropped to a circle 96 points
# wide does not need more, and the client downscales before sending anyway —
# this is the ceiling for a client that does not, not the expected size.
MAX_BYTES: Final = 5 * 1024 * 1024

# Magic numbers, in the order they appear in the file. The value is the
# extension we store it under and the content type we serve it back as.
_SIGNATURES: Final[list[tuple[bytes, str, str]]] = [
    (b"\xff\xd8\xff", "jpg", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "png", "image/png"),
    (b"GIF87a", "gif", "image/gif"),
    (b"GIF89a", "gif", "image/gif"),
]


class InvalidImage(Exception):
    """The upload is not an image we are willing to store."""


def sniff(data: bytes) -> tuple[str, str]:
    """(extension, content_type) from the file's own bytes.

    Pure, and the security-relevant half of this module, so it is testable
    without a network or a bucket.

    RIFF containers need a second look: WebP announces itself as "RIFF",
    four bytes of length, then "WEBP", and plenty of things that are not
    images also start with RIFF. Checking both ends of that header is what
    separates a WebP from a WAV file wearing the same first four bytes.
    """
    if len(data) < 12:
        raise InvalidImage("That file is too small to be an image.")

    for signature, extension, content_type in _SIGNATURES:
        if data.startswith(signature):
            return extension, content_type

    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp", "image/webp"

    # HEIC/HEIF, which is what an iPhone produces by default. The box starts
    # at byte 4 with "ftyp", and the brand that follows says which flavour.
    if data[4:8] == b"ftyp" and data[8:12] in {
        b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1", b"heim", b"heis",
    }:
        return "heic", "image/heic"

    raise InvalidImage("That file does not look like an image.")


def _object_name(user_id: UUID, extension: str) -> str:
    """Where this user's picture lives.

    Random rather than named after the user: the bucket is public, so a
    predictable name would let anyone holding an account id fetch the
    picture. It also means replacing a picture produces a genuinely new URL
    instead of one a CDN will keep serving from cache.
    """
    return f"{user_id}/{uuid.uuid4().hex}.{extension}"


def _path_within_bucket(url: str) -> str | None:
    """The object name inside an avatar URL, or None if it is not one of ours.

    Guards the delete path: only an object this module could have written
    should ever be removed by it, so a profile whose avatar_url points
    somewhere else entirely is left alone rather than parsed hopefully.
    """
    marker = f"/{BUCKET}/"
    if not url or marker not in url:
        return None
    return url.split(marker, 1)[1].split("?", 1)[0] or None


async def store(user_id: UUID, data: bytes) -> str:
    """Upload a picture and return its public URL. Raises InvalidImage."""
    if not data:
        raise InvalidImage("That file is empty.")
    if len(data) > MAX_BYTES:
        raise InvalidImage("That image is larger than 5 MB.")

    extension, content_type = sniff(data)
    name = _object_name(user_id, extension)

    client = get_client()
    client.storage.from_(BUCKET).upload(
        name,
        data,
        # Cached hard, which is safe only because the name is random: a new
        # picture is a new URL, so nothing ever needs the cache invalidated.
        # The old object's URL may keep serving from the edge for a while
        # after deletion, which costs nothing — no profile points at it.
        {"content-type": content_type, "cache-control": "31536000"},
    )
    # get_public_url leaves a bare "?" on the end. Harmless to fetch, but it
    # gets stored in a column and shown in logs, so it goes.
    return client.storage.from_(BUCKET).get_public_url(name).rstrip("?")


async def discard(url: str | None) -> None:
    """Delete a previously stored picture. Never raises.

    Best effort on purpose. An orphaned object costs a few kilobytes; a
    failure here that propagated would fail the request that just succeeded
    in giving the user a new picture, which is the wrong thing to care about.
    """
    path = _path_within_bucket(url or "")
    if not path:
        return
    try:
        get_client().storage.from_(BUCKET).remove([path])
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not remove old avatar %s: %s", path, exc)
