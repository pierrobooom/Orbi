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

RUN\_REMINDER\_DISPATCHER=1

NOTIFICATIONS\_DISPATCH\_SECRET=

RUN\_FINANCE\_SCHEDULER=1

BANK\_PROVIDER=manual

```

`RUN_REMINDER_DISPATCHER=1` and `RUN_FINANCE_SCHEDULER=1` (both the default)
run their background loops inside the API process. **They are now safe on any
number of replicas**: each loop takes a lease from the `job_leases` table
before doing anything, and only the holder works while the rest skip the tick.
Claiming is a conditional UPDATE, so Postgres arbitrates — under READ
COMMITTED a second claimant re-evaluates its WHERE clause against the
committed row and matches nothing. See services/job_lease.py.

This replaces the earlier advice to disable the loops past one instance and
drive them from external cron. That still works and the endpoint still exists
— POST `/api/v1/notifications/dispatch` with an `X-Dispatch-Secret` header
matching `NOTIFICATIONS_DISPATCH_SECRET`, which returns 503 while the secret
is unset so it cannot be left accidentally open — but it is no longer
required, and a leased in-process loop needs no cron infrastructure to get
right.

What the lease protects is mostly money: duplicate reminders are an
annoyance, duplicate bank syncs are billed, because bank data is priced per
connected account per month and every replica would sync every account.

`BANK_PROVIDER` selects the bank-data aggregator adapter in
services/bank_providers.py. `manual` (the default) is the null provider: it
fetches nothing, so no automatic import happens and transactions arrive only
from manual entry, receipts and recurring rules. Setting it to a real
provider requires that provider's credentials — see the finance section below
for why an IBAN alone is not one.



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

Open before a test release. Reviewed against the code on 2026-09-18 — four
items previously listed here were already done and have been removed
(transcript logging IS gated in services/privacy.py, the bubble cap IS
enforced at routers/tasks.py, weekday parsing was fixed, and the Chat tab
shipped). Verify before trusting this list again.

\- Groq Developer tier — the free tier's 200k tokens/day cannot serve one Pro user
\- FINANCE INTELLIGENCE is still sold and not built. Pro's "weekly + monthly
  reports, AI insights, anomaly detection" and Genius's "daily reports,
  proactive insights, cross-month patterns" have no implementation:
  agents/finance_agent.py's generate_insights is called by nothing and the
  finance_insights table has no db helper touching it. Migration 0012 built
  the STRUCTURE underneath it (accounts with derived balances, recurring
  rules, bank-sync seam) but nothing yet generates an insight.
\- Finance has no mobile surface for any of 0012. The Money tab is still
  entry logging and a monthly total: no account list, no balances, no
  recurring-rule editor, no connection status. Backend is complete and
  tested; the client has not caught up.
\- BANK SYNC IS A SEAM, NOT AN INTEGRATION. services/bank_sync.py and the
  daily scheduler are built and tested against a fake provider, and
  BANK_PROVIDER defaults to a null adapter that fetches nothing. No
  aggregator is configured, because none can be without a licence.
  An IBAN is a LABEL, not a credential. finance_accounts.iban exists to
  match imported transactions to the right account — it cannot fetch
  anything, from anyone. Reading an account requires the holder to
  authenticate at their own bank and consent to a licensed AISP, which
  returns a token; bank_connections.consent_reference is where that token's
  handle goes. Do not add an adapter that takes an IBAN and expects data.
  Vendor state as of 2026-09-19: GoCardless/Nordigen (the free default) is
  closed to new signups; Enable Banking is the current self-serve route with
  a free Restricted Production mode against your own accounts. Pricing is
  per connected account per month and unpublished — price it BEFORE
  building, the way the ElevenLabs decision should have been.
\- Reminder actions are built but UNVERIFIED. The Done / Snooze / Tomorrow
  / Pick-a-time / Reply buttons exist (hooks/useNotificationActions.ts) and
  categories are registered at runtime, which MAY work in Expo Go on iOS
  but is not documented to. Confirm on a dev build before believing it.
  iOS cannot record the microphone from a notification at all — the
  text-input action, whose keyboard offers system dictation, is the
  achievable version of "talk to the notification", not a placeholder.
\- agents/reminder_planner.py is now dead code. services/reminder_schedule.py
  replaced it with arithmetic; nothing imports the agent. Delete it or
  reduce it to copy generation, but do not leave a second, divergent idea
  of when reminders fire lying around.
\- Tasks with no due date get no reminders at all. A deliberate boundary in
  reminder_schedule.py, and an honest product gap: every event there is
  defined relative to due_at. Revisit if undated tasks turn out to be the
  common case.
\- No in-app view of the reminder schedule. GET /notifications/plans exists
  and returns the daily budget alongside the plans, so "why didn't I get
  told?" is answerable — nothing renders it. It also returns the 100
  EARLIEST plans by trigger_at, which is the wrong end: fix the query
  (pending ascending plus recent history descending) before rendering it.
  Finished plans are now pruned (cancelled after 7 days, sent/answered/
  skipped after 30 — reminder_dispatcher.RETENTION_DAYS), so the view can
  only ever explain the last month.




