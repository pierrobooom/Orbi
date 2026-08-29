"""Pick the best cluster for a freshly parsed task.

Why this exists
---------------
The original matcher (task_sanitizer.match_cluster_id) compared the LLM's
free-text `domain_hint` against cluster names with a bidirectional
substring test, first hit wins:

    if hint in name or name in hint

That fails in both directions. It fires on accidental substrings — hint
"work" matches a cluster called "Homework" or "Network" — and it misses
every relationship that isn't lexical: a task hinted `work` has zero
overlap with a cluster named "Freelance", and "MOT booking" shares no
substring with "Car Stuff". Iteration order was weight_score desc, and
every weight_score is 0.0 in practice, so which cluster won was
effectively arbitrary.

Strategy
--------
Compare meaning, not spelling. Both sides get embedded into the same
1024-dim space and the best cosine similarity wins, provided it clears
_MIN_SIMILARITY. Below that the task goes to Drift, which is the honest
answer — a task about nothing the user has a cluster for SHOULD sit
unassigned rather than be forced into the least-bad bucket.

The task side embeds the task's own text (title/label/description) plus
the domain hint, not the hint alone: "Book MOT for the Golf" carries far
more signal than the single word "personal".

Cluster embeddings are generated lazily and cached on the row, keyed by
`embedding_source`. A rename changes the source text, which invalidates
the cache and triggers exactly one re-embed on next use. Steady state is
zero extra API calls per match beyond the single query embedding.

Falls back to the substring matcher whenever embeddings are unavailable
(no API key, network down, brand-new clusters that haven't embedded yet)
so cluster assignment degrades rather than disappears.
"""

import logging
from typing import Any, Sequence

from app.db import clusters as clusters_db
from app.services.embeddings import generate_embedding
from app.services.task_sanitizer import match_cluster_id

logger = logging.getLogger(__name__)

# Cosine similarity below this is treated as "no good cluster". Tuned
# against real user data: a clearly on-topic pair ("Go to the gym" vs
# "Health and fitness") scores 0.60, a reasonable one ("Buy new tyres" vs
# "Car Stuff") 0.34, and an unrelated one ("Learn the accordion" vs
# anything) 0.24. 0.30 keeps the reasonable matches with headroom for
# phrasing variance, while letting genuinely unrelated tasks fall to
# Drift — where the user or the auto-organiser can place them
# deliberately. Drift is a fine answer; a confidently wrong cluster is
# not.
_MIN_SIMILARITY = 0.30


def _cluster_embed_text(cluster: dict) -> str:
    """The text that represents a cluster in embedding space.

    Summary is included when present — "Car Stuff" alone is thin, but
    "Car Stuff — MOT, insurance, servicing" is a rich anchor.
    """
    parts = [str(cluster.get("name") or "").strip()]
    summary = str(cluster.get("summary") or "").strip()
    if summary:
        parts.append(summary)
    return " — ".join(p for p in parts if p)


def build_task_query_text(
    title: str | None,
    label: str | None,
    description: str | None,
    domain_hint: str | None,
) -> str:
    """Join everything that says what this task is ABOUT.

    domain_hint goes last and is deliberately included: it's the model's
    own one-word summary and is a useful tiebreaker, but it must not be
    the only signal — that's what made the substring matcher so brittle.
    """
    parts: list[str] = []
    for value in (title, label, description, domain_hint):
        cleaned = str(value or "").strip()
        if cleaned and cleaned.lower() not in {p.lower() for p in parts}:
            parts.append(cleaned)
    return " — ".join(parts)


def _cosine(a: Sequence[float], b: Sequence[float]) -> float:
    """Cosine similarity. Returns 0.0 for mismatched or zero vectors."""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = 0.0
    norm_a = 0.0
    norm_b = 0.0
    for x, y in zip(a, b):
        dot += x * y
        norm_a += x * x
        norm_b += y * y
    if norm_a <= 0.0 or norm_b <= 0.0:
        return 0.0
    return dot / ((norm_a**0.5) * (norm_b**0.5))


def _parse_vector(raw: Any) -> list[float] | None:
    """Normalise a pgvector column into a list of floats.

    PostgREST hands vectors back as a string like "[0.1,0.2,...]" rather
    than a JSON array, so both forms have to be accepted.
    """
    if raw is None:
        return None
    if isinstance(raw, list):
        try:
            return [float(v) for v in raw]
        except (TypeError, ValueError):
            return None
    if isinstance(raw, str):
        text = raw.strip()
        if not text.startswith("[") or not text.endswith("]"):
            return None
        body = text[1:-1].strip()
        if not body:
            return None
        try:
            return [float(part) for part in body.split(",")]
        except ValueError:
            return None
    return None


async def _cluster_vector(cluster: dict) -> list[float] | None:
    """Return this cluster's embedding, generating and caching if needed.

    A cached vector is reused only when `embedding_source` still matches
    the current name+summary. That's what makes a rename cheap: the
    vector refreshes once, on the next match, instead of on every read
    or on every rename.
    """
    source_text = _cluster_embed_text(cluster)
    if not source_text:
        return None

    cached = _parse_vector(cluster.get("embedding"))
    if cached and cluster.get("embedding_source") == source_text:
        return cached

    vector = await generate_embedding(source_text)
    if vector is None:
        # Fall back to a stale vector if we have one — an out-of-date
        # embedding still beats no match at all.
        return cached

    try:
        await clusters_db.update_cluster_embedding(
            cluster["id"], vector, source_text
        )
    except Exception as exc:  # noqa: BLE001 — caching is best-effort
        logger.warning("Could not cache cluster embedding: %s", exc)
    return vector


async def match_cluster_semantic(
    query_text: str,
    domain_hint: str | None,
    clusters: list[dict],
) -> str | None:
    """Return the id of the best-matching cluster, or None for Drift.

    Never raises. Any failure in the embedding path degrades to the
    original substring matcher so task creation always completes.
    """
    if not clusters:
        return None

    # Exact hint→name match short-circuits everything. This is the one
    # lexical test worth keeping: it has no false positives (unlike the
    # old substring test, where "work" matched "Homework"), it costs
    # nothing, and it beats the embedding on cases where topical words
    # crowd out the domain — "Email Sarah about Q2 budget" scores highest
    # against a "Finances" cluster because of the word "budget", when the
    # hint plainly said `work` and a cluster named "Work" exists.
    hint = (domain_hint or "").strip().lower()
    if hint:
        for cluster in clusters:
            if str(cluster.get("name") or "").strip().lower() == hint:
                return cluster.get("id")

    try:
        query_vector = await generate_embedding(query_text)
    except Exception as exc:  # noqa: BLE001 — never block task creation
        logger.warning("Cluster match embedding failed: %s", exc)
        query_vector = None

    if query_vector is None:
        return match_cluster_id(domain_hint, clusters)

    best_id: str | None = None
    best_score = 0.0
    for cluster in clusters:
        vector = await _cluster_vector(cluster)
        if not vector:
            continue
        score = _cosine(query_vector, vector)
        if score > best_score:
            best_score = score
            best_id = cluster.get("id")

    if best_id is None:
        # Nothing embedded successfully — don't silently drop to Drift
        # when the lexical matcher might still find something.
        return match_cluster_id(domain_hint, clusters)

    if best_score < _MIN_SIMILARITY:
        logger.info(
            "Cluster match below threshold (%.3f < %.2f) — routing to Drift",
            best_score, _MIN_SIMILARITY,
        )
        return None

    logger.info("Cluster match: %s (similarity %.3f)", best_id, best_score)
    return best_id
