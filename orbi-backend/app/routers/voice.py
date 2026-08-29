"""Voice router — transcription, TTS, and voice debrief flow.

The voice layer has two boundaries:

1. STT — accept audio uploads, return transcript text.
   Handled by Deepgram in the cloud. The mobile client may also transcribe
   on-device with whisper.cpp; if it does, this endpoint is not called.

2. TTS — accept text, return MP3 audio bytes.
   Handled by ElevenLabs and gated to Pro/Premium tiers only.

The debrief flow chains: start → many turns → end. Each turn pushes a
ConversationEvent so the debrief integrates with the existing chat history,
and the final structured extraction is stored on the VoiceSession row.
"""

import logging
from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import Response

from app.agents import debrief_agent
from app.db import conversations as conv_db, users as users_db, voice_sessions as voice_db
from app.models.conversation import ConversationSource
from app.models.voice import (
    TranscriptionResult,
    TTSRequest,
    VoiceSession,
    VoiceSessionKind,
    VoiceSessionStart,
    VoiceSessionStatus,
    VoiceTurnRequest,
    VoiceTurnResponse,
)
from app.services import transcription, tts
from app.services.auth import get_current_user, get_current_user_with_tier

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/voice", tags=["voice"])


def _error(message: str, error_code: str) -> dict:
    """Build a structured error response body."""
    return {"message": message, "error_code": error_code}


# --------------------------------------------------------------------------
# Speech to text
# --------------------------------------------------------------------------

@router.post("/transcribe", response_model=TranscriptionResult)
async def transcribe(
    audio: UploadFile = File(..., description="Recorded audio file (webm, m4a, wav, mp3)"),
    language: str | None = Form(
        None,
        description="BCP-47 tag, e.g. 'pt-PT'. Falls back to the stored preference.",
    ),
    auth: dict = Depends(get_current_user_with_tier),
):
    """Transcribe an uploaded audio file via Deepgram.

    The mobile client uses on-device Whisper as the primary path. This
    endpoint is the cloud fallback when Whisper is unavailable or low-confidence.
    """
    user_id = auth["user_id"]
    user_tier = auth["tier"]

    # Deepgram needs the language up front — it can't be inferred from
    # the audio. An explicit form field wins so the client reflects a
    # settings change immediately; otherwise use the stored preference.
    if not language:
        try:
            prefs = await users_db.fetch_preferences(user_id)
            language = (prefs or {}).get("language")
        except Exception as exc:  # noqa: BLE001 — never block transcription
            logger.warning("Could not read language preference: %s", exc)
            language = None

    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=_error("Audio payload is empty.", "AUDIO_EMPTY"),
        )

    try:
        result = await transcription.transcribe_audio(
            audio_bytes=audio_bytes,
            user_id=user_id,
            user_tier=user_tier,
            mimetype=audio.content_type or "audio/webm",
            language=language,
        )
    except transcription.TranscriptionQuotaExceeded as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=_error(str(exc), "STT_QUOTA_EXCEEDED"),
        )
    except RuntimeError as exc:
        # API key missing — configuration error, not a transient failure
        logger.error("Transcription configuration error: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=_error(
                "Cloud transcription is not configured.",
                "STT_NOT_CONFIGURED",
            ),
        )
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=_error(
                "Transcription provider unavailable. Try again.",
                "STT_PROVIDER_DOWN",
            ),
        )

    return TranscriptionResult(**result)


# --------------------------------------------------------------------------
# Text to speech
# --------------------------------------------------------------------------

@router.post("/tts")
async def text_to_speech(
    body: TTSRequest,
    auth: dict = Depends(get_current_user_with_tier),
):
    """Synthesize speech audio from text.

    Returns audio/mpeg bytes directly so the client can stream it without
    a JSON wrapper. Free tier users receive 402 — they should fall back to
    the device's native TTS engine on the client side.
    """
    user_id = auth["user_id"]
    user_tier = auth["tier"]

    if not tts.is_tier_eligible(user_tier):
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=_error(
                "Cloud text-to-speech requires Pro or Premium. "
                "Use the device's native TTS engine on free tier.",
                "TTS_TIER_REQUIRED",
            ),
        )

    try:
        result = await tts.synthesize_speech(
            text=body.text,
            user_id=user_id,
            user_tier=user_tier,
            voice_id=body.voice_id,
        )
    except PermissionError as exc:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=_error(str(exc), "TTS_TIER_REQUIRED"),
        )
    except tts.TtsQuotaExceeded as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=_error(str(exc), "TTS_QUOTA_EXCEEDED"),
        )
    except RuntimeError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=_error(
                "Cloud TTS is not configured.",
                "TTS_NOT_CONFIGURED",
            ),
        )
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=_error(
                "Text-to-speech provider unavailable.",
                "TTS_PROVIDER_DOWN",
            ),
        )

    return Response(
        content=result["audio_bytes"],
        media_type=result["mimetype"],
        headers={
            "X-TTS-Provider": result["provider"],
            "X-TTS-Voice-Id": result["voice_id"],
            "X-TTS-Character-Count": str(result["character_count"]),
        },
    )


# --------------------------------------------------------------------------
# Voice debrief flow
# --------------------------------------------------------------------------

@router.post("/debrief/start", response_model=VoiceSession, status_code=status.HTTP_201_CREATED)
async def start_debrief(
    body: VoiceSessionStart,
    user_id: UUID = Depends(get_current_user),
):
    """Start a new voice debrief session.

    Creates both a VoiceSession row and links it to a fresh conversation
    session_id so the turns flow into conversation_events alongside text chat.
    """
    now = datetime.now(timezone.utc)
    voice_session_id = uuid4()
    conversation_session_id = uuid4()

    payload = {
        "id": str(voice_session_id),
        "user_id": str(user_id),
        "conversation_session_id": str(conversation_session_id),
        "kind": body.kind.value,
        "status": VoiceSessionStatus.active.value,
        "topic": body.topic,
        "started_at": now.isoformat(),
    }

    row = await voice_db.insert_voice_session(payload)
    return row


@router.post("/debrief/turn", response_model=VoiceTurnResponse)
async def debrief_turn(
    body: VoiceTurnRequest,
    auth: dict = Depends(get_current_user_with_tier),
):
    """Process one turn in an active voice debrief.

    Flow:
    1. Verify the voice session belongs to the user and is still active.
    2. Persist the user message as a ConversationEvent (source=voice).
    3. Call the debrief_agent with the conversation history.
    4. Persist the assistant reply as a ConversationEvent.
    5. If the agent signalled completion, stamp the VoiceSession with
       status=completed and store the extraction.
    """
    user_id = auth["user_id"]
    user_tier = auth["tier"]

    session = await voice_db.fetch_voice_session(body.voice_session_id, user_id)
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Voice session not found.", "VOICE_SESSION_NOT_FOUND"),
        )
    if session["status"] != VoiceSessionStatus.active.value:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=_error(
                "Voice session is no longer active.",
                "VOICE_SESSION_NOT_ACTIVE",
            ),
        )

    conversation_session_id = UUID(session["conversation_session_id"])
    now = datetime.now(timezone.utc)

    # Persist user turn
    await conv_db.insert_conversation_event({
        "id": str(uuid4()),
        "user_id": str(user_id),
        "session_id": str(conversation_session_id),
        "role": "user",
        "content": body.user_message,
        "source": ConversationSource.voice.value,
        "created_at": now.isoformat(),
    })

    history = await conv_db.fetch_conversation_history(
        user_id, conversation_session_id, limit=30
    )
    history_messages = [{"role": h["role"], "content": h["content"]} for h in history]

    result = await debrief_agent.continue_debrief(
        user_message=body.user_message,
        conversation_history=history_messages,
        user_id=user_id,
        user_tier=user_tier,
    )

    reply = result["response"]
    is_complete = result["is_complete"]
    extraction = result["extraction"]

    # Persist assistant turn
    await conv_db.insert_conversation_event({
        "id": str(uuid4()),
        "user_id": str(user_id),
        "session_id": str(conversation_session_id),
        "role": "assistant",
        "content": reply,
        "source": ConversationSource.voice.value,
        "intent": "debrief",
        "agent_used": "debrief_agent",
        "created_at": datetime.now(timezone.utc).isoformat(),
    })

    if is_complete:
        started_at = datetime.fromisoformat(session["started_at"].replace("Z", "+00:00"))
        ended_at = datetime.now(timezone.utc)
        duration = (ended_at - started_at).total_seconds()
        await voice_db.update_voice_session(
            body.voice_session_id,
            user_id,
            {
                "status": VoiceSessionStatus.completed.value,
                "ended_at": ended_at.isoformat(),
                "extraction": extraction,
                "duration_seconds": duration,
            },
        )

    return VoiceTurnResponse(
        voice_session_id=body.voice_session_id,
        conversation_session_id=conversation_session_id,
        reply=reply,
        is_complete=is_complete,
        extraction=extraction,
    )


@router.post("/debrief/{voice_session_id}/end", response_model=VoiceSession)
async def end_debrief(
    voice_session_id: UUID,
    user_id: UUID = Depends(get_current_user),
):
    """Manually end a voice session before extraction completes.

    Used when the user taps "stop" mid-debrief. Marks the session abandoned
    so analytics can distinguish it from a fully-extracted completion.
    """
    session = await voice_db.fetch_voice_session(voice_session_id, user_id)
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Voice session not found.", "VOICE_SESSION_NOT_FOUND"),
        )
    if session["status"] != VoiceSessionStatus.active.value:
        return session

    started_at = datetime.fromisoformat(session["started_at"].replace("Z", "+00:00"))
    ended_at = datetime.now(timezone.utc)
    duration = (ended_at - started_at).total_seconds()

    updated = await voice_db.update_voice_session(
        voice_session_id,
        user_id,
        {
            "status": VoiceSessionStatus.abandoned.value,
            "ended_at": ended_at.isoformat(),
            "duration_seconds": duration,
        },
    )
    return updated or session


@router.get("/debrief", response_model=list[VoiceSession])
async def list_voice_sessions(
    user_id: UUID = Depends(get_current_user),
):
    """List the user's recent voice sessions, newest first."""
    return await voice_db.fetch_recent_voice_sessions(user_id)


@router.get("/debrief/{voice_session_id}", response_model=VoiceSession)
async def get_voice_session(
    voice_session_id: UUID,
    user_id: UUID = Depends(get_current_user),
):
    """Fetch a single voice session by ID."""
    row = await voice_db.fetch_voice_session(voice_session_id, user_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Voice session not found.", "VOICE_SESSION_NOT_FOUND"),
        )
    return row
