// The short text inside a task bubble, derived from its title when the
// server sent none: the ACTION and its OBJECT — "Visitar imóvel".
//
// One copy for the whole app. There used to be three (the universe layout,
// the new-task screen and the confirm screen), each dropping the verb and
// keeping the noun, so "Visitar um imóvel" became just "Imóvel": a bubble
// that says what, but not what to do about it. Mirrors the server's
// derive_label_from_title in services/task_sanitizer.py.

const STOP_WORDS = new Set([
  // English
  "a", "an", "the", "to", "from", "about", "of", "for", "with",
  "and", "or", "in", "on", "at", "by", "as", "is", "was", "are",
  "be", "been", "this", "that", "these", "those", "my", "your",
  "i", "im", "i'm", "ive", "i've",
  // Portuguese: articles, contractions, possessives, prepositions
  "o", "os", "as", "um", "uma", "uns", "umas", "de", "do", "da", "dos",
  "das", "em", "no", "na", "nos", "nas", "ao", "aos", "à", "às", "para",
  "com", "por", "pelo", "pela", "meu", "minha", "meus", "minhas", "seu",
  "sua", "e",
]);

export function deriveLabel(title: string, maxChars = 20): string {
  const trimmed = (title ?? "").trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxChars) return trimmed;
  const words = trimmed.split(/\s+/);
  const first = words[0];
  if (first.length > maxChars) return trimmed.slice(0, maxChars);
  // Titles are imperative, so the first word is the action. Its object is
  // the next word that is not an article or a preposition. One object: a
  // third word is usually the start of a place ("Visitar imóvel São…").
  const object = words.slice(1).find((w) => {
    const lower = w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
    return lower.length > 0 && !STOP_WORDS.has(lower);
  });
  if (object && `${first} ${object}`.length <= maxChars) return `${first} ${object}`;
  return first;
}
