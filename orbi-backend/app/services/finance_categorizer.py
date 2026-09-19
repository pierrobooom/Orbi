"""Rule-based merchant categorization for finance entries.

Rules are applied before any AI call. If no rule matches, the caller receives
"uncategorized" and may optionally escalate to the AI router for inference.
Every merchant a rule catches is an AI call that never happens, which is why
this table is worth keeping good.

Rules are defined in CLAUDE.md and must stay in sync with that document.

MATCHING IS ON WORD BOUNDARIES, NOT RAW SUBSTRINGS
This used to be a plain `keyword in merchant` test, and short keywords ate
longer merchant names from the inside. "tfl" (Transport for London) is a
substring of ne-TFL-ix, and because it sat higher in the list, every Netflix
subscription in the database was categorised as transport. The same trap was
loaded for "coop" inside Coopers, "apple" inside Applebee's, "pret" inside
anything Pretty, and "bp" inside a dozen ordinary words.

The lookarounds below require a non-word character (or a string edge) on each
side, which is what "a word on its own" actually means. They are lookarounds
rather than \\b because several keywords end in punctuation — "disney+",
"co-op", "b&q" — and \\b after a "+" asserts the opposite of what is wanted.
"""

import re

# Merchant keyword → category mapping.
# Keys are lowercase and matched as whole words. Order still matters: the
# first match wins, so a more specific rule ("amazon prime", "uber eats") must
# come before the general one it contains.
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

    # -----------------------------------------------------------------
    # Portugal
    # -----------------------------------------------------------------
    # The table above is entirely UK, which made it close to useless for the
    # market the app is actually being tested in: a Continente shop, the most
    # ordinary transaction in the country, fell through to "uncategorized" and
    # straight on to a paid AI call.
    # Groceries
    ("continente", "groceries"),
    ("pingo doce", "groceries"),
    ("minipreco", "groceries"),
    ("minipreço", "groceries"),
    ("intermarche", "groceries"),
    ("intermarché", "groceries"),
    ("auchan", "groceries"),
    ("jumbo", "groceries"),
    ("mercadona", "groceries"),
    ("celeiro", "groceries"),
    # Transport
    ("galp", "transport"),
    ("repsol", "transport"),
    ("prio", "transport"),
    ("cepsa", "transport"),
    ("via verde", "transport"),
    ("carris", "transport"),
    ("metro de lisboa", "transport"),
    ("comboios", "transport"),
    ("cp ", "transport"),
    ("tap", "transport"),
    ("brisa", "transport"),
    # Dining
    ("padaria", "dining"),
    ("pastelaria", "dining"),
    ("restaurante", "dining"),
    ("cafe", "dining"),
    ("café", "dining"),
    ("glovo", "dining"),
    ("bolt food", "dining"),
    # Health
    ("farmacia", "health"),
    ("farmácia", "health"),
    ("ginasio", "health"),
    ("ginásio", "health"),
    ("continente saude", "health"),
    ("wells", "health"),
    # Home / utilities
    ("worten", "home"),
    ("leroy merlin", "home"),
    ("aki", "home"),
    ("edp", "home"),
    ("galp energia", "home"),
    ("aguas", "home"),
    ("águas", "home"),
    # Subscriptions / telecom
    ("meo", "subscriptions"),
    ("nos ", "subscriptions"),
    ("vodafone", "subscriptions"),
    ("nowo", "subscriptions"),
    # Finance
    ("seguros", "finance"),
    ("financas", "finance"),
    ("finanças", "finance"),
    ("credito", "finance"),
    ("crédito", "finance"),
    ("multibanco", "finance"),
]

# Compiled once. `(?<!\w)` / `(?!\w)` mean "not glued to a word character",
# which is the real definition of a standalone word and, unlike \b, behaves
# correctly for keywords that end in punctuation.
_COMPILED: list[tuple[re.Pattern[str], str]] = [
    (re.compile(rf"(?<!\w){re.escape(keyword)}(?!\w)"), category)
    for keyword, category in _RULES
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
    for pattern, category in _COMPILED:
        if pattern.search(normalised):
            return category
    return "uncategorized"
