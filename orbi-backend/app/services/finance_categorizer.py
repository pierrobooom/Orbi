"""Rule-based merchant categorization for finance entries.

Rules are applied before any AI call. If no rule matches, the caller receives
"uncategorized" and may optionally escalate to the AI router for inference.

Rules are defined in CLAUDE.md and must stay in sync with that document.
"""

# Merchant keyword → category mapping.
# Keys are lowercase substrings to match against the merchant name.
# Order matters within each category group but not across groups —
# the first match wins, so more specific strings should come first.
_RULES: list[tuple[str, str]] = [
    # Groceries
    ("tesco", "groceries"),
    ("sainsbury", "groceries"),
    ("lidl", "groceries"),
    ("aldi", "groceries"),
    ("morrisons", "groceries"),
    ("asda", "groceries"),
    ("waitrose", "groceries"),
    ("co-op", "groceries"),
    ("coop", "groceries"),
    # Transport
    ("tfl", "transport"),
    ("national rail", "transport"),
    ("trainline", "transport"),
    ("ryanair", "transport"),
    ("bolt", "transport"),
    ("shell", "transport"),
    ("esso", "transport"),
    ("bp", "transport"),
    # Subscriptions — check "amazon prime" before bare "amazon" so Prime
    # is not mis-categorised as Shopping
    ("amazon prime", "subscriptions"),
    ("netflix", "subscriptions"),
    ("spotify", "subscriptions"),
    ("disney+", "subscriptions"),
    ("disney plus", "subscriptions"),
    ("youtube", "subscriptions"),
    ("apple", "subscriptions"),
    ("google", "subscriptions"),
    # Dining
    ("mcdonald", "dining"),
    ("nando", "dining"),
    ("deliveroo", "dining"),
    ("uber eats", "dining"),
    ("just eat", "dining"),
    ("pret", "dining"),
    ("greggs", "dining"),
    # Health
    ("boots", "health"),
    ("gym", "health"),
    ("pharmacy", "health"),
    ("nhs", "health"),
    ("dentist", "health"),
    ("vision express", "health"),
    # Finance
    ("mortgage", "finance"),
    ("hmrc", "finance"),
    ("insurance", "finance"),
    ("credit card", "finance"),
    ("loan", "finance"),
    ("bank", "finance"),
    # Shopping — bare "amazon" after "amazon prime" above
    ("amazon", "shopping"),
    ("asos", "shopping"),
    ("zara", "shopping"),
    ("h&m", "shopping"),
    ("hm", "shopping"),
    ("ebay", "shopping"),
    ("primark", "shopping"),
    # Home
    ("ikea", "home"),
    ("b&q", "home"),
    ("screwfix", "home"),
    ("dyson", "home"),
    ("currys", "home"),
    # Transport — Uber after "uber eats" so ride-hailing is not misread as dining
    ("uber", "transport"),
]


def categorize_merchant(merchant: str) -> str:
    """Return the category for a merchant name using rule-based matching.

    Matching is case-insensitive substring search. The first rule that matches
    wins. If no rule matches, returns "uncategorized" — the caller should then
    decide whether to escalate to the AI router.

    Args:
        merchant: Raw merchant name as received from the user or bank import.

    Returns:
        A lowercase category string, e.g. "groceries", or "uncategorized".
    """
    normalised = merchant.lower().strip()
    for keyword, category in _RULES:
        if keyword in normalised:
            return category
    return "uncategorized"
