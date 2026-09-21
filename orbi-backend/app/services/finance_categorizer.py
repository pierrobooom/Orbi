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
import unicodedata

from app.services.merchant_cleanup import is_transfer

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
    # ---------------------------------------------------------------------
    # Generic Portuguese words, not brands.
    #
    # A brand table can never cover every neighbourhood restaurant, and the
    # long tail is where "uncategorized" actually comes from. But Portuguese
    # businesses put what they ARE in their name — Tasquinha, Padaria,
    # Farmácia, Ginásio — so the kind of place is usually right there in the
    # string. These generalise to every user in the country, which is more
    # than any brand ever does.
    # ---------------------------------------------------------------------
    ("tasquinha", "dining"),
    ("tasca", "dining"),
    ("restaurante", "dining"),
    ("cervejaria", "dining"),
    ("marisqueira", "dining"),
    ("churrasqueira", "dining"),
    ("pastelaria", "dining"),
    ("padaria", "dining"),
    ("confeitaria", "dining"),
    ("gelataria", "dining"),
    ("snack", "dining"),
    ("cafe", "dining"),
    ("bar ", "dining"),
    ("take away", "dining"),
    ("takeaway", "dining"),
    ("farmacia", "health"),
    ("clinica", "health"),
    ("hospital", "health"),
    ("dentista", "health"),
    ("medico", "health"),
    ("ginasio", "health"),
    ("gym", "health"),
    ("fitness", "health"),
    ("cinema", "leisure"),
    ("cinemas", "leisure"),
    ("teatro", "leisure"),
    ("museu", "leisure"),
    ("livraria", "leisure"),
    ("estacionamento", "transport"),
    ("parking", "transport"),
    ("via verde", "transport"),
    ("portagem", "transport"),
    ("combustivel", "transport"),
    ("minipreco", "groceries"),
    ("mercado", "groceries"),
    ("supermercado", "groceries"),
    ("talho", "groceries"),
    ("peixaria", "groceries"),
    ("frutaria", "groceries"),
    # Moving money to and from a wallet is not spending, whichever direction
    # it goes. Without these, every Revolut top-up inflated the month.
    ("revolut", "transfers"),
    ("top-up", "transfers"),
    ("paypal", "transfers"),
    ("wise", "transfers"),
    # The bank charging for being a bank. Not a purchase, and grouping these
    # with a mortgage payment under "finance" hides them — small, frequent
    # and worth seeing as their own line.
    ("taxa de conversao", "fees"),
    ("comissao", "fees"),
    ("comissoes", "fees"),
    ("juros", "fees"),
    ("imposto do selo", "fees"),
    ("anuidade", "fees"),
    ("manutencao de conta", "fees"),
    # Cash out of a machine. Where it went afterwards is unknowable from a
    # bank feed, so it gets its own category instead of a guess.
    ("levantamento", "cash"),
]

# Compiled once. `(?<!\w)` / `(?!\w)` mean "not glued to a word character",
# which is the real definition of a standalone word and, unlike \b, behaves
# correctly for keywords that end in punctuation.
_COMPILED: list[tuple[re.Pattern[str], str]] = [
    (re.compile(rf"(?<!\w){re.escape(keyword)}(?!\w)"), category)
    for keyword, category in _RULES
]


def categorize_merchant(merchant: str, raw: str | None = None) -> str:
    """Return the category for a merchant name using rule-based matching.

    Matching is case-insensitive and accent-insensitive; the first rule that
    matches wins. If no rule matches, returns "uncategorized" — the caller
    should then decide whether to escalate to the AI router.

    Args:
        merchant: The merchant name, already cleaned of bank narrative.
        raw:      The bank's original line, when there is one. Only the raw
                  text can say whether this was a transfer, because cleaning
                  deliberately removes the words that mark it as one.

    Returns:
        A lowercase category string, e.g. "groceries", or "uncategorized".
    """
    # Money moving between a person's own accounts is not spending, and
    # filing it as "shopping" overstates every total built on top of it.
    if is_transfer(raw if raw is not None else merchant):
        return "transfers"

    # Accents are stripped before matching: the rules are written without
    # them, and "Conversao" and "Conversão" are the same word to everyone
    # except a regex.
    normalised = _strip_accents(merchant.lower().strip())
    for pattern, category in _COMPILED:
        if pattern.search(normalised):
            return category
    return "uncategorized"


def _strip_accents(value: str) -> str:
    decomposed = unicodedata.normalize("NFD", value)
    return "".join(c for c in decomposed if unicodedata.category(c) != "Mn")
