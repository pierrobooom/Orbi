"""Turn a bank's narrative line into the name of a shop.

WHY THIS EXISTS
A bank does not send merchants. It sends the text printed on a statement,
which is a sentence about a transaction with a merchant somewhere inside it:

    COMPRA 8430968 NOS CINEMAS OEIRAS
    COMPRA 8430968.08 CASCAIS PAR TVM
    Transf Imed de Lucas Pierrobom
    PAGAMENTO SERVICOS 12345 MEO

Every one of those failed to categorise, and for the same reason: the rule
table matches merchant names, and none of these IS a merchant name. The card
number in the middle also means two purchases at the same shop on different
cards look like different merchants, which quietly breaks the "top merchants"
list and every per-vendor total built on it.

So the noise comes off first. "NOS Cinemas Oeiras" matches rules, groups with
its siblings, and reads like something a person wrote.

WHAT IS DELIBERATELY NOT DONE HERE
No guessing at categories — that is the categoriser's job, working on the
cleaned name. And nothing is discarded: raw_description keeps the original
line, because when a user asks "what was this?" the bank's exact words are
the only authoritative answer.

PORTUGUESE FIRST, THEN THE OBVIOUS ENGLISH ONES
The prefixes are per-country and there is no way around enumerating them.
This covers Portuguese retail banking, which is what Orbi's users have, plus
the handful of international ones that show up on any card.
"""

import re

# Narrative prefixes, longest first so "COMPRA CONTACTLESS" is stripped as a
# unit rather than leaving "CONTACTLESS" behind.
_PREFIXES = [
    "compra contactless",
    "compra electronica",
    "compra eletronica",
    "pagamento servicos",
    "pagamento de servicos",
    "pagamento automatico",
    "transferencia para",
    "transferencia de",
    "transf imed de",
    "transf imed para",
    "transf imediata",
    "debito directo",
    "debito direto",
    "levantamento atm",
    "levantamento",
    "mb way de",
    "mb way para",
    "mbway",
    "mb way",
    "compra",
    "pagamento",
    "transferencia",
    "transf",
    "card payment to",
    "card payment",
    "direct debit",
    "payment to",
    "purchase",
    "pos ",
]

# A card or reference number: 6+ digits, optionally with a .NN suffix for the
# card within the account. Removed wherever it appears, because it is never
# part of a shop's name and its presence splits one merchant into several.
_REFERENCE = re.compile(r"(?<!\w)\d{5,}(?:\.\d{1,3})?(?!\w)")

# Trailing card fragments: "Revolut  6563" is Revolut. Four digits at the end
# of a line, after a real name, are the card's last four.
_TRAILING_CARD = re.compile(r"\s+\d{4}\s*$")

_WHITESPACE = re.compile(r"\s+")

# Words that are never part of a name and survive prefix stripping because
# they sit in the middle.
_NOISE = {"de", "da", "do", "ref", "refa", "nr", "n"}

# Brand acronyms that must not be title-cased into "Nos" or "Meo". A general
# "short and upper-case means acronym" rule was tried and turns PET CITY into
# PET CITY, so the set is explicit.
_ACRONYMS = {
    "NOS", "MEO", "EDP", "CTT", "CP", "TVM", "ATM", "IVA", "NIF", "BP",
    "IKEA", "FNAC", "SEUR", "DHL", "UPS", "BPI", "CGD", "MBWAY", "PT",
}

# Particles that stay lower-case inside a name: "Tasquinha da Mitas", not
# "Tasquinha Da Mitas".
_PARTICLES = {"de", "da", "do", "das", "dos", "e", "em", "no", "na"}

# Lines where the bank is describing its own charge rather than naming a
# payee. There is no merchant to find, so they keep a readable label of their
# own instead of being mangled into one.
_SELF_DESCRIBING = {
    "levantamento atm": "Levantamento ATM",
    "levantamento": "Levantamento",
    "taxa de conversao": "Taxa de Conversão",
    "comissao": "Comissão",
    "comissoes": "Comissões",
    "juros": "Juros",
    "imposto do selo": "Imposto do Selo",
    "anuidade": "Anuidade",
    "manutencao de conta": "Manutenção de Conta",
}


def _strip_accents_lower(value: str) -> str:
    import unicodedata

    decomposed = unicodedata.normalize("NFD", value)
    return "".join(c for c in decomposed if unicodedata.category(c) != "Mn").lower()


def clean_merchant(raw: str | None) -> str:
    """Extract the merchant from a bank narrative line.

    Returns a tidied, title-cased name. Falls back to the original text when
    stripping would leave nothing — an unrecognised format should degrade to
    the bank's own words, never to an empty row.
    """
    if not raw:
        return ""

    text = _WHITESPACE.sub(" ", raw.strip())
    flat = _strip_accents_lower(text)

    # Bank fees and charges: there is no merchant, and pretending otherwise
    # produces entries like "Taxa" filed under shopping.
    for key, label in _SELF_DESCRIBING.items():
        if flat.startswith(key):
            return label

    # Prefixes, repeatedly: "COMPRA CONTACTLESS COMPRA" happens.
    changed = True
    while changed:
        changed = False
        flat = _strip_accents_lower(text)
        for prefix in _PREFIXES:
            if flat.startswith(prefix):
                text = text[len(prefix):].strip(" -:*")
                changed = True
                break

    text = _REFERENCE.sub(" ", text)
    text = _TRAILING_CARD.sub("", text)
    text = _WHITESPACE.sub(" ", text).strip(" -:*.,")

    # Leading connective words left behind by a stripped prefix.
    words = text.split()
    while words and _strip_accents_lower(words[0]) in _NOISE:
        words.pop(0)
    text = " ".join(words)

    if not text:
        return _WHITESPACE.sub(" ", raw.strip())

    return _titlecase(text)


def _titlecase(value: str) -> str:
    """Title-case without destroying acronyms.

    Banks shout: "NOS CINEMAS OEIRAS". Lower-casing it all reads badly and
    Python's .title() turns "NOS" into "Nos" and "MBWay" into "Mbway". Short
    all-caps tokens are left exactly as they are, because in Portugal they
    are almost always the brand: NOS, EDP, CTT, CP, TVM.
    """
    out: list[str] = []
    for index, word in enumerate(value.split()):
        if word.upper() in _ACRONYMS:
            out.append(word.upper())
        elif any(c.isdigit() for c in word):
            out.append(word)
        elif index > 0 and word.lower() in _PARTICLES:
            out.append(word.lower())
        else:
            out.append(word[:1].upper() + word[1:].lower())
    return " ".join(out)


def is_transfer(raw: str | None) -> bool:
    """Does this line describe money moving between accounts?

    Worth knowing separately from its category: a transfer to your own
    savings is not spending, and counting it as such overstates every total
    on the dashboard. The categoriser maps these to "transfers", which the
    spending views can then choose to exclude.
    """
    if not raw:
        return False
    flat = _strip_accents_lower(raw)
    return any(
        flat.startswith(marker)
        for marker in ("transf", "transferencia", "mb way", "mbway", "trf")
    )
