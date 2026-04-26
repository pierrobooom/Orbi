# Orbi — Phase 2 Intelligence Core: Implementation Guide

**Date completed:** April 26, 2026  
**Branch:** dev  
**Commit:** Adding Phase 2 Intelligence Core

---

## Project Progress

| Phase | Name | Status | Target |
|-------|------|--------|--------|
| 1 | Foundation & Data Core | Done | Apr 3 – Apr 17 |
| 2 | Intelligence Core | Done | Apr 18 – May 1 |
| 3 | Voice & Conversation Layer | Not started | May 2 – May 15 |
| 4 | Mobile Frontend | Not started | May 16 – Jun 12 |
| 5 | Polish & Testing Version | Not started | Jun 13 – Jun 26 |

### Overall completion: ~35%

- Phase 1 (15%) — Backend skeleton, CRUD, scoring, DB layer
- Phase 2 (20%) — AI agents, auth, memory, chat pipeline
- Remaining (65%) — Voice pipeline, entire mobile app, polish, testing

---

## What Was Built in Phase 2

### 32 files changed, 2,213 lines added

---

### 1. Authentication — `app/services/auth.py` (NEW)

Real Supabase JWT verification replacing the placeholder `get_current_user` that returned a hardcoded UUID.

| Function | Purpose |
|----------|---------|
| `get_current_user()` | FastAPI dependency — verifies JWT, returns `UUID` |
| `get_current_user_with_tier()` | Returns `{"user_id": UUID, "tier": str}` — used when AI routing needs the subscription tier |

**Env var required:** `SUPABASE_JWT_SECRET`

**Files updated:** `routers/tasks.py` and `routers/finance.py` now import from `services/auth` instead of defining their own placeholder.

---

### 2. User Profile Endpoints — `routers/users.py` + `db/users.py` (REWRITTEN)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/users/me` | GET | Get authenticated user's profile |
| `/api/v1/users/me` | PATCH | Update profile (only `full_name` allowed) |
| `/api/v1/users/me/preferences` | GET | Get user preferences |
| `/api/v1/users/me/preferences` | PUT | Create/replace preferences |

**DB tables expected:** `user_profiles`, `user_preferences`

---

### 3. Prompt Templates — `app/prompts/` (7 files, ALL NEW/REWRITTEN)

Each agent has a versioned Markdown prompt that defines its behaviour, output format, and rules.

| File | Agent | Key output format |
|------|-------|-------------------|
| `coordinator_v1.md` | Coordinator | JSON: intent, confidence, agent, context_needed |
| `task_parser_v1.md` | Task Parser | JSON: title, description, due_at, importance, domain_hint, confidence |
| `finance_agent_v1.md` | Finance Agent | JSON: category/confidence, insight arrays, or plain text answers |
| `debrief_agent_v1.md` | Debrief Agent | Conversational text or JSON extraction with action_items, decisions, key_facts |
| `cluster_manager_v1.md` | Cluster Manager | JSON: cluster assignment or reorganisation suggestions |
| `memory_summarizer_v1.md` | Memory Summarizer | JSON: memory nodes array, synthesis summary, or plain text answers |
| `reminder_planner_v1.md` | Reminder Planner | JSON: array of notification plans with timing and urgency |

---

### 4. Agent Implementations — `app/agents/` (7 files)

All agents follow the same pattern:
1. Load their prompt via `ai_router.load_prompt()`
2. Call `ai_router.get_ai_response()` which routes to Groq (free/pro) or Claude (premium)
3. Parse the JSON response with graceful fallback on failure

| File | Functions |
|------|-----------|
| `coordinator.py` | `classify_intent()` — determines which agent handles the message |
| `task_parser.py` | `parse_task()` — natural language → structured TaskBubble fields |
| `finance_agent.py` | `categorize_unknown_merchant()`, `generate_insights()`, `answer_finance_question()` |
| `debrief_agent.py` | `continue_debrief()` — multi-turn conversation with extraction |
| `cluster_manager.py` | `assign_task_to_cluster()`, `suggest_reorganisation()` |
| `memory_summarizer.py` | `extract_memories()`, `synthesise_summary()`, `answer_memory_query()` |
| `reminder_planner.py` | `plan_reminders()` — decides notifications based on tasks + preferences |

---

### 5. Cluster System — `routers/clusters.py` + `db/clusters.py` (NEW)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/clusters` | GET | List all clusters |
| `/api/v1/clusters` | POST | Create a cluster |
| `/api/v1/clusters/{id}` | GET | Get single cluster |
| `/api/v1/clusters/{id}` | PATCH | Update cluster |
| `/api/v1/clusters/{id}` | DELETE | Delete cluster |

**Model updated:** `Cluster` in `models/task.py` now has `owner_id` field.

**DB table expected:** `clusters`

---

### 6. Memory System — `routers/memory.py` + `db/memory.py` + `services/embeddings.py` + `models/memory.py` (ALL NEW)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/memory` | GET | List memory nodes (filterable by type) |
| `/api/v1/memory` | POST | Create memory node + generate embedding |
| `/api/v1/memory/search?q=...` | GET | Semantic vector search via pgvector |
| `/api/v1/memory/{id}` | GET | Get single memory node |
| `/api/v1/memory/{id}` | DELETE | Delete memory node |

**Embedding service** (`services/embeddings.py`): Generates vector embeddings via Groq's OpenAI-compatible API. Embeddings are stored in pgvector for cosine similarity search.

**DB requirements:**
- Table `memory_nodes` with a `vector(1024)` column for embeddings
- Supabase RPC function `match_memories` for similarity search (SQL provided in `db/memory.py` docstring)

**Model:** `MemoryNode` with types: fact, decision, pattern, summary. Tags for retrieval, importance 1-10.

---

### 7. Conversation Events — `models/conversation.py` + `db/conversations.py` (NEW)

Stores all user and assistant messages with session grouping.

| Function | Purpose |
|----------|---------|
| `insert_conversation_event()` | Store a message |
| `fetch_conversation_history()` | Get messages for a session |
| `fetch_recent_sessions()` | List recent sessions |
| `fetch_session_transcript()` | Full formatted transcript for memory extraction |

**DB table expected:** `conversation_events`

---

### 8. Chat Endpoint — `routers/chat.py` (NEW)

**`POST /api/v1/chat`** — The main conversational entry point.

**Request:**
```json
{
  "message": "I need to call the dentist before Friday",
  "session_id": "optional-uuid",
  "source": "text"
}
```

**Response:**
```json
{
  "reply": "Got it — I've captured \"Call the dentist\". Due: 2026-05-01.",
  "session_id": "uuid",
  "intent": "create_task",
  "agent_used": "task_parser",
  "data": { "title": "Call the dentist", "importance": 8, ... }
}
```

**Flow:** User message → store event → coordinator classifies → route to agent → store reply → return

---

### 9. AI Finance Categorization Fallback — `routers/finance.py` (UPDATED)

`POST /api/v1/finance/entries` now:
1. Runs rule-based categorization first (as before)
2. If result is "uncategorized" AND user is pro/premium tier → calls `finance_agent.categorize_unknown_merchant()`
3. Uses AI category only if confidence >= 0.5

Uses `get_current_user_with_tier` dependency to get the subscription tier.

---

## Dependency Added

- `email-validator` (required by Pydantic's `EmailStr` in UserProfile model)
- Updated `requirements.txt`: `pydantic[email]==2.12.5`

---

## New Environment Variable

```
SUPABASE_JWT_SECRET=   # Required for auth — found in Supabase dashboard > Project Settings > API
```

---

## Database Tables Required for Phase 2

These tables need to exist in Supabase before the endpoints work:

| Table | New in Phase 2? |
|-------|-----------------|
| `user_profiles` | Yes (was referenced but not queried before) |
| `user_preferences` | Yes |
| `clusters` | Yes |
| `memory_nodes` | Yes (needs `vector(1024)` column + pgvector extension) |
| `conversation_events` | Yes |
| `task_bubbles` | No (Phase 1) |
| `finance_entries` | No (Phase 1) |
| `finance_budgets` | No (Phase 1) |

---

## What's Next — Phase 3: Voice & Conversation Layer (May 2 – May 15)

- Whisper on-device speech-to-text integration
- Deepgram cloud fallback for STT
- ElevenLabs text-to-speech for Pro+ users
- Voice debrief flow (record → transcribe → debrief agent → extract)
- Audio streaming endpoints
