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
import os
import time
from typing import Optional

from elevenlabs.client import ElevenLabs

logger = logging.getLogger(__name__)

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
    user_tier: str,
    voice_id: Optional[str] = None,
) -> dict:
    """Convert text to spoken audio via ElevenLabs.

    The tier gate is enforced here even though the router checks too — defence
    in depth keeps a future caller from accidentally bypassing the check.

    Args:
        text:      The text to synthesize.
        user_tier: Subscription tier — must be "pro" or "premium".
        voice_id:  Optional ElevenLabs voice ID. Falls back to the default.

    Returns:
        {
            "audio_bytes": bytes,    # MP3 audio payload
            "mimetype": "audio/mpeg",
            "provider": "elevenlabs",
            "voice_id": str,
            "model": str,
            "character_count": int,  # Used for cost tracking
        }

    Raises:
        PermissionError: If the user's tier is not eligible.
        RuntimeError:    If the API key is missing.
        Exception:       Any underlying API error is re-raised.
    """
    if not is_tier_eligible(user_tier):
        raise PermissionError(
            "Cloud text-to-speech is available on Pro and Premium tiers only."
        )

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
        }

    except Exception as exc:
        elapsed_ms = int((time.monotonic() - start_ms) * 1000)
        logger.error(
            "TTS failed | provider=elevenlabs latency_ms=%d error=%s",
            elapsed_ms,
            exc,
        )
        raise
