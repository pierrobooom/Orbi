"""Speech-to-text transcription service.

Two providers are supported:

1. On-device Whisper (whisper.cpp via expo module on the mobile client).
   Free for all tiers, runs locally, no network required. The mobile app
   sends the already-transcribed text directly — no backend call needed.

2. Deepgram cloud STT — the fallback when on-device Whisper is unavailable
   (low-end devices, model not downloaded yet) or fails. Available to all
   tiers but rate-limited more aggressively for free users.

This module exposes the cloud path. The on-device path is handled entirely
client-side and does not enter the backend.
"""

import logging
import math
import os
import time
from typing import Optional
from uuid import UUID

from deepgram import DeepgramClient, PrerecordedOptions

from app.services.usage_tracker import QuotaExceeded, cap_for, check_and_record

logger = logging.getLogger(__name__)


class TranscriptionQuotaExceeded(Exception):
    """Raised when the user has no STT seconds left for the day.

    The router converts this to an HTTP 429 with the user-safe message.
    """

    def __init__(self, message: str):
        super().__init__(message)


# We don't know the audio duration until Deepgram returns it, so a pre-check
# can only confirm the user still has *some* budget. We assume the upload is
# at least this many seconds before the call so a user already at zero budget
# is rejected without paying for a Deepgram round-trip.
_MIN_BILLABLE_SECONDS = 1

_DEEPGRAM_API_KEY = os.environ.get("DEEPGRAM_API_KEY", "")
_DEEPGRAM_MODEL = "nova-2"
_DEEPGRAM_LANGUAGE = "en"

_deepgram_client: Optional[DeepgramClient] = None


def _get_client() -> DeepgramClient:
    """Return a lazily-initialised Deepgram client.

    Lazy creation means the server boots even when DEEPGRAM_API_KEY is
    missing — the failure surfaces only when transcription is attempted.
    """
    global _deepgram_client
    if _deepgram_client is None:
        if not _DEEPGRAM_API_KEY:
            raise RuntimeError(
                "DEEPGRAM_API_KEY is not set. Cloud transcription is unavailable."
            )
        _deepgram_client = DeepgramClient(_DEEPGRAM_API_KEY)
    return _deepgram_client


async def transcribe_audio(
    audio_bytes: bytes,
    user_id: UUID,
    user_tier: str,
    mimetype: str = "audio/webm",
) -> dict:
    """Transcribe an audio payload via Deepgram, gated by the daily STT cap.

    Args:
        audio_bytes: Raw audio bytes uploaded from the mobile client.
        user_id:     Authenticated user — for quota tracking.
        user_tier:   DB tier value — 'free', 'pro', or 'premium'.
        mimetype:    MIME type of the audio — webm/opus, mp4/m4a, wav, etc.

    Returns:
        {
            "transcript": str,        # Full transcript text
            "confidence": float,      # 0.0–1.0
            "duration_seconds": float,
            "provider": "deepgram",
            "model": str,
        }

    Raises:
        TranscriptionQuotaExceeded: User has no STT seconds left today.
        RuntimeError: If the Deepgram API key is missing.
        Exception:    Any underlying network or API error is re-raised so the
                      router can convert it to an HTTP 503.
    """
    # Pre-check: reserve a 1-second floor before the upload so a user who is
    # already at their cap is rejected without spending a Deepgram round-trip.
    # The actual duration is recorded after the response and the difference is
    # added below.
    if cap_for(user_tier, "stt_seconds") <= 0:
        raise TranscriptionQuotaExceeded(
            "Cloud transcription is not available on your plan."
        )
    try:
        await check_and_record(user_id, user_tier, "stt_seconds", _MIN_BILLABLE_SECONDS)
    except QuotaExceeded as exc:
        raise TranscriptionQuotaExceeded(str(exc)) from None

    start_ms = time.monotonic()
    client = _get_client()

    options = PrerecordedOptions(
        model=_DEEPGRAM_MODEL,
        language=_DEEPGRAM_LANGUAGE,
        smart_format=True,
        punctuate=True,
    )

    try:
        response = client.listen.rest.v("1").transcribe_file(
            {"buffer": audio_bytes, "mimetype": mimetype},
            options,
        )
        elapsed_ms = int((time.monotonic() - start_ms) * 1000)

        # Deepgram response shape: results.channels[0].alternatives[0]
        results = response.results
        alt = results.channels[0].alternatives[0]
        duration = float(getattr(response.metadata, "duration", 0.0) or 0.0)

        # Bill the rest of the actual audio duration. The 1-second floor was
        # already recorded above, so add the remainder. Round up so we never
        # under-count partial seconds against the cap.
        billable = max(0, math.ceil(duration) - _MIN_BILLABLE_SECONDS)
        if billable > 0:
            try:
                await check_and_record(user_id, user_tier, "stt_seconds", billable)
            except QuotaExceeded:
                # The user squeezed in a long recording that pushed past the
                # cap. Deepgram has already been called and the user has their
                # transcript — no point hiding it. The over-billing reconciles
                # itself: the next call will be denied at the pre-check.
                logger.info(
                    "stt_seconds capped after Deepgram call | user=%s extra=%d",
                    user_id, billable,
                )

        logger.info(
            "Transcription completed | provider=deepgram model=%s "
            "duration_s=%.2f latency_ms=%d confidence=%.2f",
            _DEEPGRAM_MODEL,
            duration,
            elapsed_ms,
            float(alt.confidence or 0.0),
        )

        return {
            "transcript": alt.transcript or "",
            "confidence": float(alt.confidence or 0.0),
            "duration_seconds": duration,
            "provider": "deepgram",
            "model": _DEEPGRAM_MODEL,
        }

    except Exception as exc:
        elapsed_ms = int((time.monotonic() - start_ms) * 1000)
        logger.error(
            "Transcription failed | provider=deepgram latency_ms=%d error=%s",
            elapsed_ms,
            exc,
        )
        raise
