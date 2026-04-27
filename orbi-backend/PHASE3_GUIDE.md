# Orbi — Phase 3 Voice & Conversation Layer: Implementation Guide

**Date completed:** April 27, 2026
**Branch:** dev
**Commit:** Adding Phase 3 Voice & Conversation Layer

---

## Project Progress

| Phase | Name | Status | Target |
|-------|------|--------|--------|
| 1 | Foundation & Data Core | Done | Apr 3 – Apr 17 |
| 2 | Intelligence Core | Done | Apr 18 – May 1 |
| 3 | Voice & Conversation Layer | Done | May 2 – May 15 |
| 4 | Mobile Frontend | Not started | May 16 – Jun 12 |
| 5 | Polish & Testing Version | Not started | Jun 13 – Jun 26 |

### Overall completion: ~50%

- Phase 1 (15%) — Backend skeleton, CRUD, scoring, DB layer
- Phase 2 (20%) — AI agents, auth, memory, chat pipeline
- Phase 3 (15%) — Voice transcription, TTS, voice debrief flow
- Remaining (50%) — Entire mobile app, polish, testing

---

## What Was Built in Phase 3

### 6 files added, 1 modified, ~700 lines added

---

### 1. Transcription Service — `app/services/transcription.py` (NEW)

Cloud speech-to-text via Deepgram. Used as the fallback when on-device
Whisper is unavailable, model not yet downloaded, or returns low confidence.

| Function | Purpose |
|----------|---------|
| `transcribe_audio(audio_bytes, mimetype)` | Sends audio to Deepgram and returns transcript + confidence + duration |
| `_get_client()` | Lazy Deepgram client init — server boots even without the API key |

**Provider:** Deepgram `nova-2` model, English, smart-format + punctuation on.

**Returns:** dict with `transcript`, `confidence`, `duration_seconds`, `provider`, `model`.

**Note:** On-device Whisper runs entirely client-side (whisper.cpp via expo
module on mobile). When the client transcribes locally, this endpoint is
never called — saves cost on free tier.

---

### 2. Text-to-Speech Service — `app/services/tts.py` (NEW)

Cloud TTS via ElevenLabs. **Pro and Premium tiers only** — free tier falls
back to the device's native TTS engine on the client side.

| Function | Purpose |
|----------|---------|
| `synthesize_speech(text, user_tier, voice_id)` | Calls ElevenLabs and returns MP3 audio bytes |
| `is_tier_eligible(user_tier)` | Returns True if tier is `pro` or `premium` |
| `_get_client()` | Lazy ElevenLabs client init |

**Provider:** ElevenLabs `eleven_turbo_v2_5` model, default voice "Rachel"
(`21m00Tcm4TlvDq8ikWAM`), MP3 44.1kHz / 128kbps output.

**Tier gate:** enforced both in the service (defence in depth) and the router.
Free tier callers get HTTP 402 Payment Required.

---

### 3. Voice Session Model — `app/models/voice.py` (NEW)

Pydantic schemas for the voice debrief lifecycle.

| Model | Purpose |
|-------|---------|
| `VoiceSession` | Full record — id, user, status, topic, extraction, duration |
| `VoiceSessionStart` | Request body for starting a debrief |
| `VoiceSessionStatus` | Enum: `active`, `completed`, `abandoned` |
| `VoiceSessionKind` | Enum: `debrief`, `capture`, `query` |
| `TranscriptionResult` | Response shape for `/voice/transcribe` |
| `VoiceTurnRequest` | Request body for `/voice/debrief/turn` |
| `VoiceTurnResponse` | Response shape — reply, is_complete, extraction |
| `TTSRequest` | Request body for `/voice/tts` (text + optional voice_id) |

---

### 4. Voice Session DB — `app/db/voice_sessions.py` (NEW)

| Function | Purpose |
|----------|---------|
| `insert_voice_session(payload)` | Create a new debrief session |
| `fetch_voice_session(id, user_id)` | Get a single session, scoped to owner |
| `update_voice_session(id, user_id, payload)` | Update status / ended_at / extraction |
| `fetch_recent_voice_sessions(user_id, limit)` | List user's recent sessions |

**DB table expected:** `voice_sessions` (schema in module docstring).

---

### 5. Voice Router — `app/routers/voice.py` (NEW)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/voice/transcribe` | POST | Multipart audio upload → transcript |
| `/api/v1/voice/tts` | POST | Text → MP3 audio bytes (Pro+ only) |
| `/api/v1/voice/debrief/start` | POST | Begin a voice debrief session |
| `/api/v1/voice/debrief/turn` | POST | One turn — user message → agent reply, optional final extraction |
| `/api/v1/voice/debrief/{id}/end` | POST | Manually end an active session (abandoned) |
| `/api/v1/voice/debrief` | GET | List recent voice sessions |
| `/api/v1/voice/debrief/{id}` | GET | Fetch a single session |

**Debrief turn flow:**

1. Verify the voice session belongs to the user and is `active`.
2. Persist the user message as a `ConversationEvent` with `source=voice`.
3. Fetch the conversation history (up to 30 turns).
4. Call `debrief_agent.continue_debrief(...)` — same agent used by `/chat`.
5. Persist the assistant reply as a `ConversationEvent`.
6. If the agent flagged `is_complete=True`, stamp the `VoiceSession`
   row with `status=completed`, `ended_at`, `extraction`, and `duration_seconds`.

**Why reuse `conversation_events`:** keeps voice and text turns in one
unified history so memory synthesis and analytics work uniformly across
both sources. The `source` enum (`voice` | `text`) is the only divider.

---

### 6. Main Application — `main.py` (UPDATED)

Added the voice router import and registration:

```python
from app.routers import tasks, finance, users, clusters, memory, chat, voice
...
app.include_router(voice.router, prefix="/api/v1")
```

---

## Dependencies Added

Updated `requirements.txt`:

```
deepgram-sdk==3.7.7
elevenlabs==1.8.0
```

Install:

```bash
pip install -r requirements.txt
```

---

## New Environment Variables

```
DEEPGRAM_API_KEY=        # Required for cloud STT — Deepgram dashboard
ELEVENLABS_API_KEY=      # Required for cloud TTS — ElevenLabs dashboard
ELEVENLABS_VOICE_ID=     # Optional — defaults to "Rachel" preset
```

The server starts without these set, but the corresponding endpoints will
return HTTP 503 until they are configured.

---

## Database Tables Required for Phase 3

| Table | New in Phase 3? |
|-------|-----------------|
| `voice_sessions` | **Yes** — see schema below |
| `conversation_events` | No (Phase 2) — voice turns reuse this table |

### `voice_sessions` schema

```sql
create table voice_sessions (
    id uuid primary key,
    user_id uuid not null references user_profiles(id),
    conversation_session_id uuid not null,
    kind text not null,             -- 'debrief' | 'capture' | 'query'
    status text not null,           -- 'active' | 'completed' | 'abandoned'
    topic text,
    started_at timestamptz not null,
    ended_at timestamptz,
    extraction jsonb,
    duration_seconds float
);

create index voice_sessions_user_started_idx
    on voice_sessions (user_id, started_at desc);
```

---

## Voice Pipeline Architecture

```
              ┌────────────────────────┐
              │  Mobile Client (RN)    │
              │  - record audio        │
              │  - whisper.cpp (free)  │
              └────────────┬───────────┘
                           │ if local fails or unavailable
                           ▼
              ┌────────────────────────┐
              │  POST /voice/transcribe │
              │  Deepgram nova-2        │
              └────────────┬───────────┘
                           │ transcript text
                           ▼
              ┌────────────────────────┐
              │  POST /voice/debrief/  │
              │       turn             │
              │  → debrief_agent       │
              │  → Groq or Claude      │
              │    (per user_tier)     │
              └────────────┬───────────┘
                           │ reply text
                           ▼
              ┌────────────────────────┐
              │  POST /voice/tts        │
              │  ElevenLabs (Pro+)      │
              │  device TTS  (Free)     │
              └────────────┬───────────┘
                           │ audio playback
                           ▼
                       User hears reply
```

---

## Cost Profile

| Path | Cost (per minute of audio) | Tier |
|------|----------------------------|------|
| On-device Whisper STT | $0 | All tiers |
| Deepgram cloud STT | ~$0.0043 | All tiers (rate limited on free) |
| Groq debrief agent | ~$0.0001 | Free, Pro |
| Claude debrief agent | ~$0.005 | Premium |
| Device native TTS | $0 | All tiers |
| ElevenLabs TTS | ~$0.18 per 1k chars | Pro, Premium |

Free-tier voice flow is fully on-device + Groq → cost stays at ~$0.001/user/day.

---

## What's Next — Phase 4: Mobile Frontend (May 16 – Jun 12)

- React Native + Expo project scaffold
- Bubble universe canvas via React Native Skia
- Voice recording UI + whisper.cpp integration
- Calls into `/chat`, `/voice/*`, `/tasks`, `/finance/entries`, `/memory`
- Zustand stores for tasks, clusters, finance
- Expo Router navigation
- Push notification registration
- Subscription tier gating in the UI
