"""Chat router — main conversational endpoint.

This is the primary entry point for all user interactions. Messages are
routed through the coordinator agent to the appropriate specialist agent.
"""

import logging
from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from typing import Optional

logger = logging.getLogger(__name__)

from app.agents import coordinator, task_parser, finance_agent, debrief_agent
from app.db import (
    clusters as clusters_db,
    conversations as conv_db,
    finance as finance_db,
    tasks as tasks_db,
    users as users_db,
)
from app.models.conversation import ConversationSource
from app.services.auth import get_current_user_with_tier
from app.services.cluster_matcher import (
    build_task_query_text,
    match_cluster_semantic,
)
from app.services.task_resolver import resolve_task
from app.services.task_sanitizer import sanitize_parsed_task
from app.services.time_extractor import override_due_at_clock

router = APIRouter(prefix="/chat", tags=["chat"])


class ChatRequest(BaseModel):
    message: str
    session_id: Optional[UUID] = None
    source: ConversationSource = ConversationSource.text
    # IANA timezone name from the client, e.g. "Europe/London". Optional
    # so older clients keep working; when present, the coordinator uses
    # it to resolve user-stated times like "4 PM" in the user's local
    # zone before emitting ISO 8601 with the right offset.
    user_timezone: Optional[str] = None
    # BCP-47 tag. Optional — when absent the server falls back to the
    # user's stored preference, then to English.
    language: Optional[str] = None


class ChatResponse(BaseModel):
    reply: str
    session_id: UUID
    intent: str
    agent_used: Optional[str] = None
    data: Optional[dict] = None


_TASK_ACTIONS = frozenset({"complete", "delete", "update", "list"})

# Only these can be changed by voice on an existing task. Cluster moves
# are deliberately excluded — that's the auto-organiser's job, and the
# move sheet's.
_VOICE_PATCH_FIELDS = frozenset({"title", "label", "description", "due_at", "importance"})


def _clean_patch(
    raw: object,
    *,
    now: datetime,
    user_timezone: str | None,
    language: str | None,
) -> dict:
    """Sanitise an LLM-proposed patch down to fields we allow by voice."""
    if not isinstance(raw, dict):
        return {}
    candidate = {k: v for k, v in raw.items() if k in _VOICE_PATCH_FIELDS and v is not None}
    if not candidate:
        return {}
    # Reuse the create-path sanitiser for date/importance handling, then
    # keep only what the user actually asked to change — sanitize fills
    # in defaults we don't want leaking into a partial update.
    cleaned = sanitize_parsed_task(
        {"title": candidate.get("title", ""), **candidate},
        now=now,
        user_timezone=user_timezone,
        language=language,
    )
    return {k: cleaned[k] for k in candidate if k in cleaned}


def _filter_tasks(tasks: list[dict], task_filter: str | None, target: str) -> list[dict]:
    """Apply a spoken filter ("overdue", "today", a cluster name)."""
    now = datetime.now(timezone.utc)
    if task_filter == "overdue":
        out = []
        for task in tasks:
            due = task.get("due_at")
            if not due:
                continue
            try:
                if datetime.fromisoformat(str(due).replace("Z", "+00:00")) < now:
                    out.append(task)
            except ValueError:
                continue
        return out
    if task_filter == "today":
        out = []
        for task in tasks:
            due = task.get("due_at")
            if not due:
                continue
            try:
                parsed = datetime.fromisoformat(str(due).replace("Z", "+00:00"))
            except ValueError:
                continue
            if parsed.date() == now.date():
                out.append(task)
        return out
    # Anything else is treated as free text over titles — a cluster name
    # or a topic word both behave the same way here.
    needle = (task_filter or target or "").lower().strip()
    if not needle:
        return tasks
    return [t for t in tasks if needle in str(t.get("title") or "").lower()]


def _error(message: str, error_code: str) -> dict:
    """Build a structured error response body."""
    return {"message": message, "error_code": error_code}


@router.post("", response_model=ChatResponse)
async def chat(
    body: ChatRequest,
    auth: dict = Depends(get_current_user_with_tier),
):
    """Process a user message through the agent pipeline.

    Flow:
    1. Store the user message as a ConversationEvent.
    2. Coordinator classifies intent and selects an agent.
    3. Relevant agent processes the message.
    4. Store the assistant reply as a ConversationEvent.
    5. Return the reply with metadata.
    """
    user_id = auth["user_id"]
    user_tier = auth["tier"]
    session_id = body.session_id or uuid4()
    now = datetime.now(timezone.utc)

    # Language precedence: explicit request field, then the stored
    # preference, then English. The request field lets the client react
    # to a settings change without waiting for a round-trip, while the
    # stored value keeps voice capture correct for clients that don't
    # send one.
    language = body.language
    if not language:
        try:
            prefs = await users_db.fetch_preferences(user_id)
            language = (prefs or {}).get("language")
        except Exception as exc:  # noqa: BLE001 — never block capture
            logger.warning("Could not read language preference: %s", exc)
            language = None

    # Store user message
    await conv_db.insert_conversation_event({
        "id": str(uuid4()),
        "user_id": str(user_id),
        "session_id": str(session_id),
        "role": "user",
        "content": body.message,
        "source": body.source,
        "created_at": now.isoformat(),
    })

    # Fetch recent conversation history for context
    history = await conv_db.fetch_conversation_history(user_id, session_id, limit=10)
    history_messages = [{"role": h["role"], "content": h["content"]} for h in history]

    # Coordinator classifies intent
    classification = await coordinator.classify_intent(
        user_message=body.message,
        user_id=user_id,
        user_tier=user_tier,
        conversation_history=history_messages,
        user_timezone=body.user_timezone,
        language=language,
    )

    intent = classification.get("intent", "general_chat")
    agent_name = classification.get("agent")
    reply = ""
    data = None

    # Route to the appropriate agent
    if intent == "general_chat" or agent_name is None:
        reply = classification.get("response_to_user", "How can I help you?")

    elif agent_name == "task_action" or intent == "query_tasks":
        # Voice commands against tasks that already exist: complete,
        # delete, reschedule, list.
        #
        # NOTHING is mutated here. The server resolves which task the
        # user meant and hands back a proposal; the client confirms
        # before anything is written. A misheard "delete the dentist
        # one" must never be able to destroy a task on its own, and the
        # same rule already governs /tasks/{id}/voice-update.
        payload = classification.get("data")
        payload = payload if isinstance(payload, dict) else {}
        raw_action = str(payload.get("action") or "").strip().lower()
        # query_tasks is the pre-v3 spelling of task_action/list and
        # carries no action field; anything unrecognised is also safest
        # read as a list, which changes nothing.
        action = raw_action if raw_action in _TASK_ACTIONS else "list"
        target = str(payload.get("target") or "").strip()
        task_filter = str(payload.get("filter") or "").strip().lower() or None

        try:
            user_tasks = await tasks_db.fetch_tasks_for_user(user_id)
        except Exception as exc:  # noqa: BLE001 — never 500 a voice command
            logger.warning("task_action could not load tasks: %s", exc)
            user_tasks = []
        active = [t for t in user_tasks if t.get("status") == "active"]

        if action == "list":
            matches = _filter_tasks(active, task_filter, target)
            data = {
                "action": "list",
                "filter": task_filter,
                "task_ids": [str(t["id"]) for t in matches],
                "count": len(matches),
            }
            reply = (
                f"{len(matches)} task(s)." if matches else "Nothing matches that."
            )
        else:
            resolution = await resolve_task(
                target=target, user_id=user_id, active_tasks=active
            )
            match = resolution["task"]
            if match is None:
                data = {"action": action, "resolved": False, "target": target}
                reply = f'I couldn\'t find a task matching "{target}".'
            else:
                data = {
                    "action": action,
                    "resolved": True,
                    "ambiguous": resolution["ambiguous"],
                    "target": target,
                    "task": {
                        "id": str(match["id"]),
                        "title": match.get("title"),
                        "label": match.get("label"),
                        "due_at": match.get("due_at"),
                        "importance": match.get("importance"),
                        "parent_cluster_id": (
                            str(match["parent_cluster_id"])
                            if match.get("parent_cluster_id")
                            else None
                        ),
                    },
                    "alternatives": [
                        {"id": str(a["id"]), "title": a.get("title")}
                        for a in resolution["alternatives"]
                    ],
                    "patch": _clean_patch(
                        payload.get("patch"),
                        now=now,
                        user_timezone=body.user_timezone,
                        language=language,
                    ),
                }
                reply = f'{action.title()}: "{match.get("title")}"?'

        logger.warning(
            "Task action | action=%s target=%r resolved=%s tz=%s",
            action, target, data.get("resolved", "n/a"), body.user_timezone or "<none>",
        )

    elif agent_name == "task_parser":
        # Coordinator v1 now embeds task extraction in `data` for
        # create_task intents — this halves the LLM round-trips on the
        # voice-create flow. Fall back to a dedicated task_parser call
        # only if the embedded data is missing or malformed.
        # Three shapes have to be accepted here:
        #   1. coordinator v2  -> {"tasks": [ {...}, {...} ]}
        #   2. coordinator v1  -> {...} (a bare task object)
        #   3. no usable data  -> fall back to a dedicated task_parser call
        # v1's shape is still handled because an older cached prompt, or a
        # model that ignores the array instruction, shouldn't drop the task
        # on the floor.
        embedded = classification.get("data")
        raw_task_list: list[dict] = []
        parser_path = "fallback"
        if isinstance(embedded, dict) and isinstance(embedded.get("tasks"), list):
            raw_task_list = [
                t for t in embedded["tasks"]
                if isinstance(t, dict) and t.get("title")
            ]
            parser_path = "embedded_multi"
        elif isinstance(embedded, dict) and embedded.get("title"):
            raw_task_list = [embedded]
            parser_path = "embedded"
        if not raw_task_list:
            fallback = await task_parser.parse_task(
                user_input=body.message,
                user_id=user_id,
                user_tier=user_tier,
            )
            if isinstance(fallback, dict) and fallback.get("title"):
                raw_task_list = [fallback]
            parser_path = "fallback"

        # A model that returns an empty array on a create_task intent
        # leaves nothing to confirm — treat that as a failed parse rather
        # than handing the client an empty queue.
        if not raw_task_list:
            return ChatResponse(
                reply="I couldn't make out a task in that — try again?",
                session_id=session_id,
                intent=intent,
                agent_used=agent_name,
                data=None,
            )

        # Clusters are fetched once for the whole batch rather than per
        # task — the list is identical for every task in one utterance.
        try:
            user_clusters = await clusters_db.fetch_clusters_for_user(user_id)
        except Exception as exc:  # noqa: BLE001 — non-fatal enrichment
            logger.warning("Cluster lookup failed during task parse: %s", exc)
            user_clusters = []

        parsed_tasks: list[dict] = []
        for raw_parsed in raw_task_list:

            # Defensive cleanup: strip verbose title prefixes, null out
            # implausible due_at, clamp importance, etc. Shared between
            # both parser paths so behaviour is identical. user_timezone
            # lets the sanitizer interpret naive local times correctly —
            # the prompt instructs the LLM to emit local time with no
            # zone marker.
            parsed = sanitize_parsed_task(
                raw_parsed,
                now=now,
                user_timezone=body.user_timezone,
                language=language,
            )

            # Authoritative clock-time override: if the transcript
            # contained an explicit time ("at 20", "8 PM", "10:30"), use
            # that hour/minute regardless of what the LLM produced. The
            # LLM still owns the DATE (it is good at "tomorrow",
            # "Friday") but the HOUR comes from a regex on the
            # transcript.
            #
            # Only applied when the utterance produced a SINGLE task.
            # With several tasks there is no way to tell which one "at 8"
            # belonged to, and stamping every task with the same hour is
            # worse than trusting the per-task due_at the model emitted.
            if len(raw_task_list) == 1:
                parsed["due_at"] = override_due_at_clock(
                    parsed.get("due_at"),
                    body.message,
                    body.user_timezone,
                    language=language,
                )

            # Resolve the cluster. Without this the mobile always lands
            # voice tasks in Drift, because the embedded data only
            # carries a free-text domain hint, not an id.
            #
            # Semantic match on the task's full text rather than a
            # substring test on the hint alone — see cluster_matcher for
            # why the substring version put "Create website" (hint
            # "work") into a cluster called "Car Stuff". Falls back to
            # the substring matcher when embeddings are unavailable.
            if not parsed.get("parent_cluster_id"):
                cluster_id = await match_cluster_semantic(
                    build_task_query_text(
                        parsed.get("title"),
                        parsed.get("label"),
                        parsed.get("description"),
                        parsed.get("domain_hint"),
                    ),
                    parsed.get("domain_hint"),
                    user_clusters,
                )
                if cluster_id:
                    parsed["parent_cluster_id"] = cluster_id

            parsed_tasks.append(parsed)

        # Log so future bad parses are debuggable without re-running.
        # Using warning level because uvicorn's default logger config
        # propagates WARNING but not INFO for app-defined loggers.
        logger.warning(
            "Task parse | path=%s count=%d tz=%s transcript=%r sanitized=%r",
            parser_path,
            len(parsed_tasks),
            body.user_timezone or "<none>",
            body.message,
            parsed_tasks,
        )

        # `tasks` is always a list, even for one task, so the client has a
        # single shape to render. The client walks it as a confirm queue.
        data = {"tasks": parsed_tasks}
        if len(parsed_tasks) == 1:
            reply = f"Got it — I've captured \"{parsed_tasks[0]['title']}\"."
        else:
            reply = f"Got it — {len(parsed_tasks)} tasks to confirm."
        if parsed.get("due_at"):
            reply += f" Due: {parsed['due_at']}."
        if parsed.get("confidence", 1.0) < 0.5:
            reply += " I wasn't fully sure about some details — want to review?"

    elif agent_name == "finance_agent":
        # Gather spending context
        spending_data = {}
        try:
            month = now.strftime("%Y-%m")
            entries = await finance_db.fetch_entries_for_user(user_id, month=month)
            spending_data = {"month": month, "entries_count": len(entries), "entries": entries[:20]}
        except Exception:
            pass

        answer = await finance_agent.answer_finance_question(
            question=body.message,
            spending_data=spending_data,
            user_id=user_id,
            user_tier=user_tier,
        )
        reply = answer

    elif agent_name == "debrief_agent":
        result = await debrief_agent.continue_debrief(
            user_message=body.message,
            conversation_history=history_messages,
            user_id=user_id,
            user_tier=user_tier,
        )
        reply = result["response"]
        if result["is_complete"]:
            data = result["extraction"]

    elif agent_name == "memory_summarizer":
        # For memory queries, retrieve and answer
        from app.agents import memory_summarizer
        from app.db import memory as memory_db
        from app.services.embeddings import generate_embedding

        embedding = await generate_embedding(body.message)
        relevant = []
        if embedding:
            relevant = await memory_db.search_memories_by_embedding(
                user_id=user_id,
                query_embedding=embedding,
                match_count=5,
            )

        answer = await memory_summarizer.answer_memory_query(
            question=body.message,
            relevant_memories=relevant,
            user_id=user_id,
            user_tier=user_tier,
        )
        reply = answer

    elif agent_name == "cluster_manager":
        reply = "Cluster management is available — what would you like to organise?"

    else:
        reply = classification.get("response_to_user", "I'm not sure how to help with that.")

    # Store assistant reply
    await conv_db.insert_conversation_event({
        "id": str(uuid4()),
        "user_id": str(user_id),
        "session_id": str(session_id),
        "role": "assistant",
        "content": reply,
        "source": body.source,
        "intent": intent,
        "agent_used": agent_name,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })

    return ChatResponse(
        reply=reply,
        session_id=session_id,
        intent=intent,
        agent_used=agent_name,
        data=data,
    )
