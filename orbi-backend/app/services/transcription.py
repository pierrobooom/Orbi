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
import os
import time
from typing import Optional

from deepgram import DeepgramClient, PrerecordedOptions

logger = logging.getLogger(__name__)

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
    mimetype: str = "audio/webm",
) -> dict:
    """Transcribe an audio payload via Deepgram.

    Args:
        audio_bytes: Raw audio bytes uploaded from the mobile client.
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
        RuntimeError: If the Deepgram API key is missing.
        Exception:    Any underlying network or API error is re-raised so the
                      router can convert it to an HTTP 503.
    """
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
