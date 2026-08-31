\# Orbi - Project Intelligence File



\## What This App Is

Orbi is a conversational life OS where tasks and finances live as animated bubbles

in a spatial universe. Bubbles grow based on urgency, cluster by life domain,

and behave as memory-backed agents the user can speak with.



The app has three core pillars:

1\. Spatial task universe — bubbles with mass, motion, and memory

2\. Voice-first interaction — speak to capture, debrief, and query

3\. Finance intelligence — track spending, detect patterns, suggest savings



\## App Name

Orbi



\## Target Platforms

\- Mobile: iOS and Android via React Native + Expo

\- Backend: Cloud (user's data syncs across devices)



\---



\## Business Model \& Subscription Tiers



Three tiers: Spark (free), Pro (£10.99/month), Genius (£20.99/month).

Yearly pricing — TBD, to be added before launch.

Internal tier values in the database remain `free`, `pro`, `premium` so existing

code keeps working; `premium` maps to the Genius marketing name.



\### Spark — Free

\- 50 bubbles, 3 clusters

\- Voice in: on-device Whisper (free) — full create/update/delete via speech

\- Voice out: device-native TTS (free, on-device)

\- AI model: Llama 3.1 8B via Groq (\~$0.001/user/day)

\- Finance: manual entry, rule-based categorization, view-only

\- Memory retention: 30 days

\- Agent personality: reactive — answers what you ask

\- Daily cap: 30 AI turns, 5 min cloud STT fallback. No cloud TTS.



\### Pro — £10.99/month

\- 500 bubbles, 15 clusters

\- Voice in: on-device Whisper + Deepgram cloud fallback

\- Voice out: device-native TTS (free, on-device)

\- AI model: Llama 3.1 70B via Groq

\- Finance: weekly + monthly reports, AI insights, anomaly detection

\- Memory retention: 1 year, semantic search

\- Agent personality: helpful — offers suggestions when asked

\- Daily cap: 200 AI turns, 30 min cloud STT. No cloud TTS.



\### Genius — £20.99/month

\- Unlimited bubbles and clusters

\- Everything in Pro

\- AI model: Llama 70B for daily chat + **Claude Sonnet 4.6 on-demand** for

&#x20; debriefs, weekly reviews, and monthly finance synthesis

\- Finance: daily reports, proactive insights, cross-month patterns

\- Memory retention: unlimited, cross-month synthesis

\- Agent personality: **talkative \& opinionated** — proactively starts conversations,

&#x20; offers unsolicited but useful opinions, runs full voice debriefs

\- Daily cap: 500 AI turns, 60 min cloud STT. No cloud TTS.

\- Monthly cap: 100 Claude calls



\### Subscription Rules

\- Always verify user.subscription\_tier server-side before any AI call

\- Never trust tier from client

\- Voice IN (STT) is available on every tier — Spark uses on-device only,

&#x20; Pro and Genius get cloud fallback

\- Voice OUT is the device's built-in TTS on every tier. There is no
&#x20; cloud TTS bill and no TTS meter to enforce. Priced 2026-08-31:
&#x20; ElevenLabs at the original 30-60 min/day caps cost $162-$324 per
&#x20; user/month against $9.73-$18.55 of post-Apple revenue. If a natural
&#x20; voice returns, use Deepgram Aura-1 (~12x cheaper, same vendor as
&#x20; STT, key already in .env) with caps around 10 min/day for Pro and
&#x20; 15 min/day for Genius, which models to a positive worst case.
\- Daily and monthly caps are enforced in app/services/ai\_router.py with

&#x20; graceful "limit reached, resets midnight UTC" responses, never billing surprises

\- Claude is only called for Genius users, and only for the listed high-value

&#x20; moments (debriefs, weekly reviews, monthly synthesis) — never daily chat

\- Never call any external AI for logic that can be computed locally



\### Cost Margin Targets

At average use, all paid tiers should hit 50%+ gross margin after Stripe fees,

AI provider costs, voice provider costs, and Supabase infrastructure.

The hard caps above exist specifically to bound worst-case heavy users so a

single power user cannot turn negative on a tier.



\---



\## AI Configuration



\### Primary AI — Groq (Spark, Pro, and Genius daily chat)

\- Provider: Groq API (groq.com)

\- Model for Spark: llama-3.1-8b-instant (\~$0.05/$0.08 per million tokens)

\- Model for Pro and Genius: llama-3.1-70b-versatile (\~$0.59/$0.79 per million tokens)

\- Use for: task parsing, debrief conversations, finance insights,

&#x20; clustering suggestions, natural language responses, daily chat

\- Env var: GROQ\_API\_KEY



\### Premium AI — Claude (Genius only, on-demand only)

\- Provider: Anthropic API

\- Model: claude-sonnet-4-6 (default), claude-opus-4-6 (complex orchestration only)

\- Use for: voice debrief sessions, weekly reviews, monthly finance synthesis,

&#x20; long-term memory consolidation — never daily chat

\- Cost: $3/$15 per million tokens input/output

\- Cap: 100 calls/user/month enforced in ai\_router.py

\- Env var: ANTHROPIC\_API\_KEY



\### On-Device AI (No cost, no internet required)

\- Voice transcription: Whisper via whisper.cpp (runs on phone locally)

\- Pressure scoring: pure deterministic math, no AI needed

\- Finance categorization: rule-based merchant matching first,

&#x20; AI only for unknown merchants

\- Local search: SQLite FTS before hitting vector search



\### Embeddings

\- Provider: Groq or a cheap embeddings endpoint

\- Store in: pgvector inside Supabase

\- Generated for: TaskBubble, MemoryNode, FinanceEntry, ConversationEvent



\### AI Router Pattern

Every AI call must go through app/services/ai\_router.py which:

1\. Reads user.subscription\_tier

2\. Routes to correct provider (Groq or Claude)

3\. Handles fallback if provider is down

4\. Logs token usage per user for billing awareness



\---



\## Tech Stack



\### Mobile Client

\- Framework: React Native with Expo

\- Canvas/Animations: React Native Skia (bubble universe rendering)

\- Local storage: SQLite via expo-sqlite

\- Local voice: whisper.cpp via expo module or react-native-whisper

\- State management: Zustand

\- Navigation: Expo Router



\### Backend

\- Language: Python 3.12

\- Framework: FastAPI (fully async)

\- Server: Uvicorn



\### Database

\- Primary: PostgreSQL via Supabase

\- Vector search: pgvector extension (semantic memory)

\- Local cache on device: SQLite



\### Authentication

\- Provider: Supabase Auth

\- Methods: Email + Google OAuth

\- JWT tokens passed in Authorization header on every request



\### Real-time

\- Provider: Supabase Realtime

\- Use for: bubble universe sync across devices, live pressure score updates



\### Voice Pipeline

\- Speech to text: Whisper on-device for all tiers (free).

&#x20; Deepgram cloud fallback only when on-device fails or device is too low-end.

\- Text to speech: device-native TTS on every tier (free, on-device).

&#x20; No cloud TTS provider is in use. ElevenLabs was priced out on 2026-08-31 —

&#x20; see the Subscription Rules above for the numbers and for the route back

&#x20; (Deepgram Aura-1) if a natural voice is wanted later.

\- Voice IN (creating/updating/deleting tasks via speech) works on every tier.

&#x20; Tier value is turns, memory retention, and agent personality — NOT voice

&#x20; quality, which is now identical everywhere.



\### Notifications

\- Provider: Expo Push Notifications

\- Logic: server-side scheduling, push via Expo



\### Analytics

\- Event-based telemetry for: prompt effectiveness,

&#x20; notification dismiss rate, merge acceptance rate, AI call latency



\---



\## Backend Folder Structure



```

orbi-backend/

&#x20; app/

&#x20;   routers/          # FastAPI route handlers only — no logic here

&#x20;   services/         # All business logic lives here

&#x20;   models/           # Pydantic v2 schemas for requests and responses

&#x20;   db/               # Database queries and Supabase client

&#x20;   agents/           # AI agent logic (coordinator, task parser, finance agent)

&#x20;   prompts/          # Prompt templates as versioned .md files

&#x20; tests/

&#x20; main.py

&#x20; requirements.txt

&#x20; .env

```



\---



\## Environment Variables



All secrets in .env file. Never hardcode keys anywhere in code.



```

SUPABASE\_URL=

SUPABASE\_ANON\_KEY=

SUPABASE\_SERVICE\_KEY=

DATABASE\_URL=

GROQ\_API\_KEY=

ANTHROPIC\_API\_KEY=

DEEPGRAM\_API\_KEY=

ELEVENLABS\_API\_KEY=

ENVIRONMENT=development

```



\---



\## Database Schema Overview



\### Core Objects

\- TaskBubble — atomic responsibility or event

\- Cluster — semantic grouping of related bubbles

\- MemoryNode — stored fact, summary, decision, or pattern

\- RelationshipEdge — links between any two objects

\- ConversationEvent — voice/chat transcript and extracted actions

\- NotificationPlan — scheduled alerts with reason and state



\### Finance Objects

\- FinanceEntry — individual income or expense record

\- FinanceBudget — monthly budget envelope per category

\- FinanceInsight — AI-generated spending observation



\### User Objects

\- UserProfile — preferences, subscription tier, interaction style

\- UserPreference — quiet hours, proactivity level, reminder style



\### Critical Fields (must exist from day one)

Every TaskBubble must have:

\- owner\_id — UUID of the user who created it (required, never null)

\- visibility — enum: private (default), shared, collaborative



These two fields are required even in MVP before any sharing feature exists.

They prevent a breaking schema migration later when sharing is built.



\---



\## Social \& Sharing Layer



Status: DESIGNED but NOT built in MVP. Schema fields prepared only.



\### What is planned (Phase 5-6, post-launch)

\- Users can connect with other users (friends, family, colleagues)

\- A TaskBubble can be shared so it appears in multiple users' universes

\- Each user's pressure score for a shared bubble is calculated independently

\- Shared bubbles sync state: if one marks done, the other is notified

\- Both can add notes; only the owner can delete



\### What to build now (Phase 1)

\- Add owner\_id to TaskBubble — UUID foreign key to UserProfile

\- Add visibility field to TaskBubble — default 'private'

\- Nothing else. No UserConnection table. No TaskShare table. No sharing UI.



\### Tables to build later (not now)

```

UserConnection:

&#x20; user\_id, connected\_user\_id, status (pending/accepted/blocked), created\_at



TaskShare:

&#x20; task\_bubble\_id, shared\_by\_user\_id, shared\_with\_user\_id,

&#x20; permission (view/collaborate), shared\_at

```



\### Finance sharing

Finance data is always private. No sharing of FinanceEntry or FinanceBudget

under any circumstance unless explicitly designed as a separate

household finance feature post-launch. Do not build toward this.



\---



\## Ranking and Pressure Score Formula



Computed deterministically in app/services/scoring.py.

No AI is involved in pressure scoring — it is pure math.



```

pressure\_score = (

&#x20;   deadline\_weight +

&#x20;   importance\_weight +

&#x20;   dependency\_weight +

&#x20;   consequence\_weight +

&#x20;   recurrence\_weight +

&#x20;   attention\_decay +

&#x20;   cluster\_pressure\_modifier

)

```



\- deadline\_weight: increases smoothly as due date approaches

\- importance\_weight: user or system estimate of delay cost

\- dependency\_weight: rises when other tasks or people are blocked

\- consequence\_weight: missed payments, missed opportunities, reputational risk

\- recurrence\_weight: surfaces cyclical tasks before they become urgent

\- attention\_decay: revives neglected unresolved items

\- cluster\_pressure\_modifier: raises profile when a domain is heating up



\---



\## Finance Categorization Rules



Apply these rules BEFORE calling any AI for categorization.

Only call AI if no rule matches the merchant name.



```

Groceries:      Tesco, Sainsbury's, Lidl, Aldi, Morrisons, Asda, Waitrose, Co-op

Transport:      TfL, Uber, Bolt, Shell, BP, Esso, National Rail, Trainline, Ryanair

Subscriptions:  Netflix, Spotify, Apple, Google, Amazon Prime, Disney+, YouTube

Dining:         McDonald's, Nando's, Deliveroo, Uber Eats, Just Eat, Pret, Greggs

Health:         Boots, Gym, Pharmacy, NHS, Dentist, Vision Express

Finance:        Bank, Mortgage, Loan, Credit Card, Insurance, HMRC

Shopping:       ASOS, Zara, H\&M, Amazon (non-Prime), eBay, Primark

Home:           IKEA, B\&Q, Screwfix, Dyson, Currys

```



\---



\## Agent Architecture



\### Agents (in app/agents/)

\- coordinator.py — owns dialogue, routes intent to correct agent

\- task\_parser.py — converts speech/text to structured TaskBubble

\- cluster\_manager.py — suggests groupings and domain assignments

\- debrief\_agent.py — handles post-event extraction and follow-ups

\- finance\_agent.py — categorizes entries, generates insights, detects anomalies

\- memory\_summarizer.py — condenses history into reusable context

\- reminder\_planner.py — decides when and how to notify



\### Prompt Templates (in app/prompts/)

\- Each agent has its own versioned .md prompt file

\- Naming: agent\_name\_v1.md, agent\_name\_v2.md

\- Never hardcode prompts inside Python files

\- Prompts are loaded at runtime from the prompts/ folder



\---



\## Coding Conventions



\### General

\- Always use async/await for all endpoints and database calls

\- Use Pydantic v2 models for all request/response schemas

\- Use type hints on every function parameter and return value

\- Never put business logic inside routers — routers call services only

\- All database queries go in app/db/ folder

\- Double quotes for strings

\- Descriptive variable names, no abbreviations



\### Comments

\- Add a comment explaining WHY not WHAT for non-obvious logic

\- Every service function must have a docstring



\### Error Handling

\- Always return structured error responses with a message and error\_code field

\- Never expose internal errors or stack traces to the client

\- Log errors server-side with enough context to debug



\### AI Calls

\- Always wrap AI calls in try/except with a graceful fallback response

\- Never make a blocking AI call in the request/response cycle if it can be queued

\- Log every AI call with: provider, model, tokens used, user tier, latency ms



\---



\## Security Rules



\- Never log full user transcripts in production

\- Anonymize data in all analytics events

\- Subscription tier always verified server-side, never trusted from client

\- Rate limit all AI endpoints per user per minute

\- Finance data requires re-authentication after 30 minutes of inactivity

\- All endpoints require valid Supabase JWT except /health and /auth routes



\---



\## Current Build Phase

Phase 4 — Mobile Frontend. Feature-complete; hardening and cost work in progress.
Last updated: Aug 30, 2026. The original Jun 12 window and Jun 26 test-release
date were not met — treat the dates below as history, not as a plan.

Completed phases:
\- Phase 1 (Foundation & Data Core) — Apr 3 – Apr 17
\- Phase 2 (Intelligence Core) — Apr 18 – May 1
\- Phase 3 (Voice & Conversation Layer) — May 2 – May 15
\- Phase 4 (Mobile Frontend) — May 16 onward; shipped auth, bubble universe,
  two-level zoom + pan, voice capture, multi-task confirm queue, voice commands
  on existing tasks, semantic search + cluster matching, Money tab, tier gating,
  push registration, European Portuguese (pipeline + UI), overdue/Done task views

Open before a test release:
\- Groq Developer tier — the free tier's 200k tokens/day cannot serve one Pro user
\- Voice provider costs priced 2026-08-31: device TTS chosen, Deepgram STT kept
\- Reminder firing — reminder_planner is imported by nothing, there is no
  notification_plans table and no scheduler, so nothing ever fires
\- Chat / Memory tab — backend complete, no mobile surface
\- Weekday parsing — "Friday" resolves to the wrong date in EN and PT
\- Gate transcript logging behind ENVIRONMENT (violates the security rules above)
\- Server-side bubble cap — the client is currently the only enforcement




