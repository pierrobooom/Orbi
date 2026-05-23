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
)
from app.models.conversation import ConversationSource
from app.services.auth import get_current_user_with_tier
from app.services.task_sanitizer import match_cluster_id, sanitize_parsed_task
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


class ChatResponse(BaseModel):
    reply: str
    session_id: UUID
    intent: str
    agent_used: Optional[str] = None
    data: Optional[dict] = None


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
    )

    intent = classification.get("intent", "general_chat")
    agent_name = classification.get("agent")
    reply = ""
    data = None

    # Route to the appropriate agent
    if intent == "general_chat" or agent_name is None:
        reply = classification.get("response_to_user", "How can I help you?")

    elif agent_name == "task_parser":
        # Coordinator v1 now embeds task extraction in `data` for
        # create_task intents — this halves the LLM round-trips on the
        # voice-create flow. Fall back to a dedicated task_parser call
        # only if the embedded data is missing or malformed.
        embedded = classification.get("data")
        if isinstance(embedded, dict) and embedded.get("title"):
            raw_parsed = embedded
            parser_path = "embedded"
        else:
            raw_parsed = await task_parser.parse_task(
                user_input=body.message,
                user_id=user_id,
                user_tier=user_tier,
            )
            parser_path = "fallback"

        # Defensive cleanup: strip verbose title prefixes, null out
        # implausible due_at (Llama 8B occasionally hallucinates 2024),
        # clamp importance, etc. Shared between both parser paths so
        # behaviour is identical. user_timezone lets the sanitizer
        # interpret naive local times correctly — the prompt instructs
        # the LLM to emit local time without any zone marker.
        parsed = sanitize_parsed_task(
            raw_parsed,
            now=now,
            user_timezone=body.user_timezone,
        )

        # Authoritative clock-time override: if the user's transcript
        # contained an explicit time ("at 20", "8 PM", "10:30"), use
        # that hour/minute regardless of what the LLM produced. The
        # LLM still owns the DATE (it's good at "tomorrow", "Friday")
        # but the HOUR comes from a regex on the transcript so we
        # don't trust Llama 8B's clock math.
        parsed["due_at"] = override_due_at_clock(
            parsed.get("due_at"),
            body.message,
            body.user_timezone,
        )

        # Resolve domain_hint -> parent_cluster_id by looking up the
        # user's clusters. Without this the mobile always lands voice
        # tasks in Drift because the embedded data only carries the
        # free-text hint, not an id.
        if not parsed.get("parent_cluster_id"):
            try:
                clusters = await clusters_db.fetch_clusters_for_user(user_id)
                cluster_id = match_cluster_id(parsed.get("domain_hint"), clusters)
                if cluster_id:
                    parsed["parent_cluster_id"] = cluster_id
            except Exception as exc:  # noqa: BLE001 — non-fatal enrichment
                logger.warning("Cluster lookup failed during task parse: %s", exc)

        # Log so future bad parses are debuggable without re-running.
        # Using warning level because uvicorn's default logger config
        # propagates WARNING but not INFO for app-defined loggers.
        logger.warning(
            "Task parse | path=%s tz=%s transcript=%r raw=%r sanitized=%r",
            parser_path,
            body.user_timezone or "<none>",
            body.message,
            raw_parsed,
            parsed,
        )

        data = parsed
        reply = f"Got it — I've captured \"{parsed['title']}\"."
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
