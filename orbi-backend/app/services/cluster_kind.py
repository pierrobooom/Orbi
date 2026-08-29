"""Cluster kind classification.

`kind` drives where a cluster sits on the mobile canvas and which palette
anchor it uses. It is assigned ONCE, when the cluster is created, and is
never re-derived afterwards.

That "never re-derived" part is the whole point of this module existing.
The mobile client used to classify on every render from the cluster's
current name, which made renaming destructive: a cluster renamed to
something without a recognised keyword silently became 'drift', changing
its colour and teleporting it to canvas centre, where it also suppressed
the client's synthetic Drift cluster and stranded every uncategorised
task. Storing the kind removes that whole class of bug.

The keyword table mirrors KIND_KEYWORDS in orbi-mobile's universeLayout.ts
and the backfill in migration 0007. If you change one, change all three.
"""

from typing import Final

VALID_KINDS: Final[frozenset[str]] = frozenset(
    {"work", "health", "finance", "personal", "home", "learning", "drift"}
)

DEFAULT_KIND: Final[str] = "drift"

# Order matters — first match wins, same as the client.
_KIND_KEYWORDS: Final[tuple[tuple[str, tuple[str, ...]], ...]] = (
    ("work", ("work", "job", "office", "career")),
    ("health", ("health", "fitness", "wellness", "gym", "medical")),
    ("finance", ("finance", "money", "bills", "budget", "expense")),
    ("personal", ("personal", "family", "social", "friends")),
    ("home", ("home", "house", "chores", "garden")),
    ("learning", ("learning", "study", "reading", "course")),
)


def classify_kind(name: str | None) -> str:
    """Return the canvas kind for a cluster name.

    Falls back to 'drift' when nothing matches — which is correct for a
    freshly created cluster with an idiosyncratic name ("Car Stuff").
    Drift-kind clusters are laid out as ordinary clusters by the client;
    they no longer collide with the synthetic catch-all.
    """
    if not name:
        return DEFAULT_KIND
    lowered = name.lower()
    for kind, keywords in _KIND_KEYWORDS:
        if any(keyword in lowered for keyword in keywords):
            return kind
    return DEFAULT_KIND


def coerce_kind(value: str | None, *, fallback_name: str | None = None) -> str:
    """Validate a client-supplied kind, falling back to name classification.

    Never raises — an unknown kind from the client is a client bug, not a
    reason to reject the whole cluster create.
    """
    if isinstance(value, str) and value in VALID_KINDS:
        return value
    return classify_kind(fallback_name)
