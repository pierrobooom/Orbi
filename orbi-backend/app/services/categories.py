"""Categories a user owns, and a categoriser that learns from corrections.

THE ORDER OF AUTHORITY, AND WHY IT IS THIS WAY
    1. What the user told us      (merchant_rules, source='user')
    2. A cached model answer      (merchant_rules, source='ai')
    3. The static rule table      (finance_categorizer)
    4. A model, once, in a batch  (and the answer is then cached at 2)
    5. "uncategorized"

The user is first because they are right by definition: it is their money
and their idea of what counts as "dining". A categoriser that keeps
overruling a correction is worse than one that never guessed, because the
user has to fight it every month.

The cache sits above the static table deliberately. If a model has been paid
for once, that answer should not be replaced by a rule change later — the
user may have accepted it, and a category that silently moves breaks every
comparison with previous months.

WHY THE MODEL RUNS IN A BATCH, ONCE
A bank feed produces dozens of unknown merchants at a time. One call per
merchant is dozens of calls for a task that is trivially parallel in a single
prompt, and each answer is then cached for ever, so a given shop is paid for
exactly once per user no matter how often they visit it.
"""

import json
import logging
import re
import unicodedata
from uuid import UUID, uuid4

from app.agents._utils import strip_json_fences
from app.db.client import get_client
from app.services.ai_router import AIRateLimited, get_ai_response
from app.services.finance_categorizer import categorize_merchant

logger = logging.getLogger(__name__)

# Seeded for every user on first use. Slugs match the static rule table's
# outputs, so a rule that returns "groceries" lands on a category that
# exists. Labels are the user's to change.
DEFAULT_CATEGORIES: list[dict] = [
    {"slug": "groceries", "label": "Groceries", "icon": "shopping-cart"},
    {"slug": "dining", "label": "Eating out", "icon": "restaurant"},
    {"slug": "transport", "label": "Transport", "icon": "directions-bus"},
    {"slug": "subscriptions", "label": "Subscriptions", "icon": "subscriptions"},
    {"slug": "home", "label": "Home", "icon": "home"},
    {"slug": "health", "label": "Health", "icon": "favorite"},
    {"slug": "shopping", "label": "Shopping", "icon": "shopping-bag"},
    {"slug": "leisure", "label": "Leisure", "icon": "sports-esports"},
    {"slug": "finance", "label": "Finance", "icon": "account-balance"},
    {"slug": "fees", "label": "Bank fees", "icon": "receipt"},
    {"slug": "cash", "label": "Cash", "icon": "payments"},
    {"slug": "transfers", "label": "Transfers", "icon": "swap-horiz"},
    {"slug": "income", "label": "Income", "icon": "trending-up"},
    {"slug": "other", "label": "Other", "icon": "more-horiz"},
]

# How many unknown merchants go into one prompt. Beyond this the answer gets
# long enough to risk truncation, and the batch is cheap to repeat.
_BATCH_SIZE = 30


def match_key(merchant: str | None) -> str:
    """The form a merchant is stored and compared in.

    Lower-cased and accent-stripped, so "Tasquinha da Mitas" and "TASQUINHA
    DA MITAS" are one merchant and not two rules that each need correcting.
    """
    if not merchant:
        return ""
    decomposed = unicodedata.normalize("NFD", merchant.strip().lower())
    return "".join(c for c in decomposed if unicodedata.category(c) != "Mn")


async def ensure_defaults(user_id: UUID) -> list[dict]:
    """Seed this user's categories if they have none, and return them all.

    Seeded per user rather than shared: renaming "Eating out" is then a
    rename, not a change to everyone else's app.
    """
    client = get_client()
    rows = (
        client.table("finance_categories")
        .select("*")
        .eq("user_id", str(user_id))
        .order("position")
        .execute()
        .data
        or []
    )
    if rows:
        return rows

    seeded = [
        {
            "id": str(uuid4()),
            "user_id": str(user_id),
            "slug": item["slug"],
            "label": item["label"],
            "icon": item["icon"],
            "is_default": True,
            "position": index,
        }
        for index, item in enumerate(DEFAULT_CATEGORIES)
    ]
    client.table("finance_categories").insert(seeded).execute()
    return seeded


async def learn(user_id: UUID, merchant: str, category: str, source: str = "user") -> None:
    """Remember that this merchant belongs in this category.

    A user correction is never overwritten by automation: an AI answer that
    disagrees with something the user typed is wrong by definition, whatever
    the model thinks.
    """
    key = match_key(merchant)
    if not key or not category or category == "uncategorized":
        return

    client = get_client()
    existing = (
        client.table("merchant_rules")
        .select("id,source")
        .eq("user_id", str(user_id))
        .eq("merchant", key)
        .limit(1)
        .execute()
        .data
        or []
    )
    if existing:
        if existing[0].get("source") == "user" and source != "user":
            return
        client.table("merchant_rules").update(
            {"category": category, "source": source}
        ).eq("id", existing[0]["id"]).execute()
        return

    client.table("merchant_rules").insert(
        {
            "id": str(uuid4()),
            "user_id": str(user_id),
            "merchant": key,
            "category": category,
            "source": source,
        }
    ).execute()


async def learned_rules(user_id: UUID) -> dict[str, str]:
    """Everything this user has taught us, as merchant key → category."""
    rows = (
        get_client()
        .table("merchant_rules")
        .select("merchant,category")
        .eq("user_id", str(user_id))
        .execute()
        .data
        or []
    )
    return {row["merchant"]: row["category"] for row in rows}


def categorise(merchant: str, raw: str | None, rules: dict[str, str]) -> str:
    """Categorise one merchant against the learned rules, then the static ones."""
    learned = rules.get(match_key(merchant))
    if learned:
        return learned
    return categorize_merchant(merchant, raw)


async def categorise_unknowns(
    merchants: list[str],
    user_id: UUID,
    user_tier: str,
    allowed: list[str],
) -> dict[str, str]:
    """Ask a model about merchants nothing else could place. One call.

    Returns merchant → category for the ones it was confident about, and
    caches each answer so the same shop is never paid for twice. Returns {}
    on any failure: an uncategorised entry is a small annoyance, and a broken
    import is not.
    """
    unique = list(dict.fromkeys(m for m in merchants if m))[:_BATCH_SIZE]
    if not unique:
        return {}

    prompt = (
        "Categorise each merchant into exactly one of these categories:\n"
        f"{', '.join(allowed)}\n\n"
        "Merchants:\n"
        + "\n".join(f"- {name}" for name in unique)
        + '\n\nReturn only a JSON object mapping each merchant exactly as given '
        'to its category, e.g. {"Tasquinha da Mitas": "dining"}. '
        'Use "other" when genuinely unsure — a wrong category is worse than none.'
    )

    try:
        raw = await get_ai_response(
            prompt=prompt,
            user_id=user_id,
            user_tier=user_tier,
            system_prompt=(
                "You categorise merchant names for a personal finance app. "
                "Many are Portuguese. Answer with JSON only."
            ),
            intent="daily_chat",
            max_tokens=700,
        )
    except AIRateLimited:
        logger.info("Merchant categorisation skipped — rate limited")
        return {}
    except Exception as exc:  # noqa: BLE001
        logger.warning("Merchant categorisation failed: %s", exc)
        return {}

    try:
        parsed = json.loads(strip_json_fences(raw))
        if not isinstance(parsed, dict):
            raise ValueError("expected a JSON object")
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("Merchant categorisation unparseable: %s | raw=%s", exc, raw[:200])
        return {}

    permitted = set(allowed)
    out: dict[str, str] = {}
    for merchant, category in parsed.items():
        slug = str(category or "").strip().lower()
        # A model that invents a category would create entries filed under
        # something that does not exist and cannot be filtered on.
        if slug not in permitted or slug in {"other", "uncategorized"}:
            continue
        out[str(merchant)] = slug
        await learn(user_id, str(merchant), slug, source="ai")
    return out


def slugify(label: str) -> str:
    """A stable identifier derived from what the user typed.

    Derived once and then frozen: entries, budgets and learned rules all
    point at the slug, so regenerating it on a rename would orphan every row
    that used the old one.
    """
    flat = match_key(label)
    slug = re.sub(r"[^a-z0-9]+", "_", flat).strip("_")
    return slug[:40]


async def create(
    user_id: UUID,
    *,
    slug: str,
    label: str,
    icon: str | None,
    color: str | None,
) -> dict | None:
    """Add a category. Returns None if the slug is already taken."""
    client = get_client()
    existing = (
        client.table("finance_categories")
        .select("id")
        .eq("user_id", str(user_id))
        .eq("slug", slug)
        .limit(1)
        .execute()
        .data
        or []
    )
    if existing:
        return None

    rows = (
        client.table("finance_categories")
        .insert(
            {
                "id": str(uuid4()),
                "user_id": str(user_id),
                "slug": slug,
                "label": label,
                "icon": icon or "label",
                "color": color,
                "is_default": False,
                "position": 100,
            }
        )
        .execute()
        .data
        or []
    )
    return rows[0] if rows else None


async def update(category_id: UUID, user_id: UUID, patch: dict) -> dict | None:
    """Change a category's presentation. Never its slug."""
    patch.pop("slug", None)
    rows = (
        get_client()
        .table("finance_categories")
        .update(patch)
        .eq("id", str(category_id))
        .eq("user_id", str(user_id))
        .execute()
        .data
        or []
    )
    return rows[0] if rows else None


async def remove(category_id: UUID, user_id: UUID) -> str:
    """Delete a user-made category. Returns 'ok', 'missing' or 'in_use'.

    A seeded category is hidden instead of deleted, and one with entries
    against it is refused: silently moving someone's history into "Other"
    because they tidied a list is not a tidy-up, it is data loss.
    """
    client = get_client()
    rows = (
        client.table("finance_categories")
        .select("*")
        .eq("id", str(category_id))
        .eq("user_id", str(user_id))
        .limit(1)
        .execute()
        .data
        or []
    )
    if not rows:
        return "missing"
    category = rows[0]

    used = (
        client.table("finance_entries")
        .select("id")
        .eq("user_id", str(user_id))
        .eq("category", category["slug"])
        .limit(1)
        .execute()
        .data
        or []
    )
    if used:
        return "in_use"

    if category.get("is_default"):
        client.table("finance_categories").update({"hidden": True}).eq(
            "id", str(category_id)
        ).execute()
        return "ok"

    client.table("finance_categories").delete().eq("id", str(category_id)).execute()
    return "ok"


async def recategorise_uncategorised(user_id: UUID, user_tier: str) -> dict:
    """Re-run the whole ladder over everything still uncategorised.

    Cheap passes first: a merchant the user has since corrected elsewhere, or
    one the static rules now know, costs nothing. Only what survives both
    reaches the model, in one call, and each answer is cached so the same
    shop is never paid for twice.
    """
    client = get_client()
    entries = (
        client.table("finance_entries")
        .select("id,merchant,raw_description,category")
        .eq("user_id", str(user_id))
        .eq("category", "uncategorized")
        .limit(500)
        .execute()
        .data
        or []
    )
    if not entries:
        return {"examined": 0, "categorised": 0, "used_ai": False, "remaining": 0}

    rules = await learned_rules(user_id)
    resolved: dict[str, str] = {}
    still_unknown: list[str] = []

    for entry in entries:
        merchant = entry.get("merchant") or ""
        if not merchant or merchant in resolved:
            continue
        category = categorise(merchant, entry.get("raw_description"), rules)
        if category != "uncategorized":
            resolved[merchant] = category
        else:
            still_unknown.append(merchant)

    used_ai = False
    if still_unknown and user_tier in ("pro", "premium"):
        categories = await ensure_defaults(user_id)
        allowed = [c["slug"] for c in categories if not c.get("hidden")]
        guessed = await categorise_unknowns(still_unknown, user_id, user_tier, allowed)
        resolved.update(guessed)
        used_ai = bool(guessed)

    updated = 0
    for entry in entries:
        category = resolved.get(entry.get("merchant") or "")
        if not category:
            continue
        client.table("finance_entries").update({"category": category}).eq(
            "id", entry["id"]
        ).execute()
        updated += 1

    return {
        "examined": len(entries),
        "categorised": updated,
        "used_ai": used_ai,
        "remaining": len(entries) - updated,
    }
