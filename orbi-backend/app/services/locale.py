"""Per-language behaviour for the capture pipeline.

Supporting a second language is not one setting — English was baked into
four separate layers, and each one silently degrades on Portuguese input:

  1. Deepgram was pinned to "en", so pt-PT audio came back as garbled
     English homophones.
  2. task_sanitizer stripped English lead-ins only. "Preciso de ligar à
     minha mãe" kept its preamble and became a task literally titled
     "Preciso de ligar à minha mãe" instead of "Ligar à mãe".
  3. time_extractor matched "at 8pm" but not "às oito da noite".
  4. Every prompt is written in English, so the model answered in
     English even when the user spoke Portuguese.

This module holds the per-language pieces so those four layers each read
from one place, and adding a fifth language means adding one Locale
rather than editing four modules.

pt-PT is European Portuguese specifically. It is NOT interchangeable with
pt-BR: vocabulary differs ("telemóvel"/"celular", "casa de banho"/
"banheiro"), and Deepgram's accent handling differs too.
"""

from dataclasses import dataclass, field
from typing import Final

DEFAULT_LANGUAGE: Final[str] = "en-GB"


@dataclass(frozen=True)
class Locale:
    """Everything the pipeline needs to know about one language."""

    tag: str
    # Human-readable, shown in the mobile settings picker.
    display_name: str
    # Deepgram's language parameter. Deepgram takes broad codes for some
    # languages, so this is not always the BCP-47 tag.
    deepgram_language: str
    # Appended to every agent system prompt. Without it the model answers
    # in the language the PROMPT is written in (English), regardless of
    # what the user said.
    prompt_instruction: str
    # Lead-ins stripped from the front of a parsed title, longest first
    # so "preciso de" wins over "preciso".
    title_prefixes: tuple[str, ...] = field(default=())


_EN_PROMPT = (
    "The user speaks English. Respond in English, and write task titles, "
    "labels, and descriptions in English."
)

_PT_PROMPT = (
    "O utilizador fala português de Portugal (pt-PT). Responde SEMPRE em "
    "português europeu, e escreve os títulos, etiquetas e descrições das "
    "tarefas em português europeu. Usa vocabulário de Portugal, nunca do "
    "Brasil (por exemplo: 'telemóvel' e não 'celular', 'casa de banho' e "
    "não 'banheiro', 'pequeno-almoço' e não 'café da manhã'). "
    "O formato JSON e os nomes dos campos permanecem EXACTAMENTE como "
    "especificado em inglês — traduz apenas os valores de texto que o "
    "utilizador vai ler. Os valores de 'domain_hint' também permanecem em "
    "inglês (work, personal, health, finance, home, social, education)."
)

# English lead-ins. Order matters — longest variants first so "i need to"
# wins over "need to".
_EN_PREFIXES: Final[tuple[str, ...]] = (
    "can you please remind me to",
    "can you remind me to",
    "please remind me to",
    "remind me to",
    "remind me",
    "i need to",
    "i have to",
    "i should",
    "i want to",
    "i'd like to",
    "i'm going to",
    "im going to",
    "i'm gonna",
    "im gonna",
    "i gotta",
    "i've got to",
    "ive got to",
    "need to",
    "have to",
    "should",
    "want to",
    "going to",
    "gonna",
    "got to",
    "gotta",
    "must",
    "have got to",
    "make sure to",
    "make sure i",
    "don't forget to",
    "dont forget to",
)

# Portuguese lead-ins. Includes unaccented spellings throughout, because
# speech-to-text output is not reliably accented and users type without
# accents constantly.
_PT_PREFIXES: Final[tuple[str, ...]] = (
    "não te esqueças de",
    "nao te esquecas de",
    "não me deixes esquecer de",
    "nao me deixes esquecer de",
    "preciso mesmo de",
    "lembra-me de",
    "lembra me de",
    "lembrar-me de",
    "tenho mesmo de",
    "tenho mesmo que",
    "eu preciso de",
    "eu tenho de",
    "eu tenho que",
    "eu quero",
    "preciso de",
    "preciso",
    "tenho de",
    "tenho que",
    "gostaria de",
    "queria",
    "quero",
    "devia",
    "deveria",
    "vou ter de",
    "vou ter que",
    "é preciso",
    "e preciso",
    "há que",
    "ha que",
    "falta",
)


_LOCALES: Final[dict[str, Locale]] = {
    "en-GB": Locale(
        tag="en-GB",
        display_name="English (UK)",
        deepgram_language="en-GB",
        prompt_instruction=_EN_PROMPT,
        title_prefixes=_EN_PREFIXES,
    ),
    "en-US": Locale(
        tag="en-US",
        display_name="English (US)",
        deepgram_language="en-US",
        prompt_instruction=_EN_PROMPT,
        title_prefixes=_EN_PREFIXES,
    ),
    "pt-PT": Locale(
        tag="pt-PT",
        display_name="Português (Portugal)",
        # Deepgram nova-2 takes "pt-PT" for European Portuguese; "pt"
        # alone biases toward Brazilian.
        deepgram_language="pt-PT",
        prompt_instruction=_PT_PROMPT,
        title_prefixes=_PT_PREFIXES,
    ),
}

SUPPORTED_LANGUAGES: Final[tuple[str, ...]] = tuple(_LOCALES.keys())


def get_locale(tag: str | None) -> Locale:
    """Return the Locale for a BCP-47 tag, falling back to the default.

    Never raises — an unknown tag (stale client, bad DB row) degrades to
    English rather than breaking capture entirely.
    """
    if tag and tag in _LOCALES:
        return _LOCALES[tag]
    if tag:
        # Accept a bare primary subtag ("pt" -> pt-PT, "en" -> en-GB) so
        # a client sending a device locale still lands somewhere sane.
        primary = tag.split("-")[0].lower()
        for candidate in _LOCALES.values():
            if candidate.tag.split("-")[0].lower() == primary:
                return candidate
    return _LOCALES[DEFAULT_LANGUAGE]


def is_portuguese(tag: str | None) -> bool:
    return get_locale(tag).tag.startswith("pt")
