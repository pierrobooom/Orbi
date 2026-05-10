"""Text-to-speech synthesis service.

Two providers:

1. ElevenLabs — natural, expressive voice. Reserved for pro and premium
   tiers because the per-character cost makes it uneconomical on free.

2. On-device native TTS — handled entirely client-side via the OS speech
   synthesizer (expo-speech / SpeechSynthesizer). No backend call. Used
   for free tier and as a graceful fallback when ElevenLabs is down.

This module exposes the cloud path only. The router enforces the tier
gate before calling synthesize_speech().
"""

import logging
import math
import os
import time
from typing import Optional
from uuid import UUID

from elevenlabs.client import ElevenLabs

from app.services.usage_tracker import QuotaExceeded, cap_for, check_and_record

logger = logging.getLogger(__name__)


class TtsQuotaExceeded(Exception):
    """Raised when the user has no TTS seconds left for the day.

    The router converts this to an HTTP 429 with the user-safe message.
    """

    def __init__(self, message: str):
        super().__init__(message)


# Rough English speech rate. We meter TTS in audio seconds (per CLAUDE.md) but
# ElevenLabs bills by character. 14 chars/sec is a standard estimate (~150 wpm)
# that lets us convert before calling the API so we never synthesise audio the
# user can't pay for.
_TTS_CHARS_PER_SECOND = 14

_ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY", "")

# Default voice — "Rachel" is a calm neutral preset that fits a life-OS
# assistant tone. Override per-user later via UserPreference if needed.
_DEFAULT_VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
_DEFAULT_MODEL_ID = "eleven_turbo_v2_5"
_DEFAULT_OUTPUT_FORMAT = "mp3_44100_128"

_PAID_TIERS = {"pro", "premium"}

_elevenlabs_client: Optional[ElevenLabs] = None


def _get_client() -> ElevenLabs:
    """Return a lazily-initialised ElevenLabs client."""
    global _elevenlabs_client
    if _elevenlabs_client is None:
        if not _ELEVENLABS_API_KEY:
            raise RuntimeError(
                "ELEVENLABS_API_KEY is not set. Cloud TTS is unavailable."
            )
        _elevenlabs_client = ElevenLabs(api_key=_ELEVENLABS_API_KEY)
    return _elevenlabs_client


def is_tier_eligible(user_tier: str) -> bool:
    """Return True if the tier may use cloud TTS (ElevenLabs)."""
    return user_tier in _PAID_TIERS


async def synthesize_speech(
    text: str,
    user_id: UUID,
    user_tier: str,
    voice_id: Optional[str] = None,
) -> dict:
    """Convert text to spoken audio via ElevenLabs, gated by the daily TTS cap.

    The tier gate is enforced here even though the router checks too — defence
    in depth keeps a future caller from accidentally bypassing the check.

    Args:
        text:      The text to synthesize.
        user_id:   Authenticated user — for quota tracking.
        user_tier: DB tier value — 'free', 'pro', or 'premium'.
        voice_id:  Optional ElevenLabs voice ID. Falls back to the default.

    Returns:
        {
            "audio_bytes": bytes,    # MP3 audio payload
            "mimetype": "audio/mpeg",
            "provider": "elevenlabs",
            "voice_id": str,
            "model": str,
            "character_count": int,
            "estimated_seconds": int,
        }

    Raises:
        PermissionError:  Tier has no TTS allowance at all (Spark, who only
                          gets a 30-second preview, also reaches here — the
                          quota check rejects them once the preview is spent).
        TtsQuotaExceeded: User has no TTS seconds left today.
        RuntimeError:     If the API key is missing.
        Exception:        Any underlying API error is re-raised.
    """
    # Estimate audio length from text length BEFORE calling ElevenLabs so we
    # never synthesise audio the user can't pay for. Round up — partial
    # seconds count against the cap.
    estimated_seconds = max(1, math.ceil(len(text) / _TTS_CHARS_PER_SECOND))

    if cap_for(user_tier, "tts_seconds") <= 0:
        raise PermissionError(
            "Cloud text-to-speech is not available on your plan."
        )

    try:
        await check_and_record(user_id, user_tier, "tts_seconds", estimated_seconds)
    except QuotaExceeded as exc:
        raise TtsQuotaExceeded(str(exc)) from None

    start_ms = time.monotonic()
    client = _get_client()
    selected_voice = voice_id or _DEFAULT_VOICE_ID

    try:
        # The SDK returns a generator of byte chunks; concat for the response.
        audio_iter = client.text_to_speech.convert(
            voice_id=selected_voice,
            model_id=_DEFAULT_MODEL_ID,
            output_format=_DEFAULT_OUTPUT_FORMAT,
            text=text,
        )
        audio_bytes = b"".join(audio_iter)
        elapsed_ms = int((time.monotonic() - start_ms) * 1000)

        logger.info(
            "TTS completed | provider=elevenlabs model=%s tier=%s "
            "chars=%d bytes=%d latency_ms=%d",
            _DEFAULT_MODEL_ID,
            user_tier,
            len(text),
            len(audio_bytes),
            elapsed_ms,
        )

        return {
            "audio_bytes": audio_bytes,
            "mimetype": "audio/mpeg",
            "provider": "elevenlabs",
            "voice_id": selected_voice,
            "model": _DEFAULT_MODEL_ID,
            "character_count": len(text),
            "estimated_seconds": estimated_seconds,
        }

    except Exception as exc:
        elapsed_ms = int((time.monotonic() - start_ms) * 1000)
        logger.error(
            "TTS failed | provider=elevenlabs latency_ms=%d error=%s",
            elapsed_ms,
            exc,
        )
        raise
