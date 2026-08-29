// UI translation.
//
// Deliberately tiny — no i18n library. The app has ~180 strings and one
// non-English language; a dependency would cost more (bundle size, an
// EAS-compatibility question, a config surface) than it saves.
//
// Keys ARE the English source text. Three consequences, all good:
//   - A missing translation renders readable English, never "screen.key".
//   - Adding an English string can't break the build.
//   - The call site still reads like the sentence it renders, so the code
//     stays greppable.
//
// Interpolation uses {name} placeholders: t("Task {n} of {total}", {n: 1,
// total: 3}). Unknown placeholders are left untouched rather than
// rendering "undefined".

import { create } from "zustand";

import { ptPT } from "./pt-PT";

export type UiLanguage = "en-GB" | "en-US" | "pt-PT";

const DICTIONARIES: Partial<Record<UiLanguage, Record<string, string>>> = {
  "pt-PT": ptPT,
  // en-GB / en-US have no dictionary — the keys are already English.
};

interface LocaleState {
  language: UiLanguage;
  setLanguage: (language: UiLanguage) => void;
}

/** Language for UI strings only.
 *
 * Seeded from the server-side preference (user_preferences.language) by
 * the root layout, and updated immediately when the user picks a new one
 * in Settings so the change is visible before the save round-trips.
 * Deliberately separate from the *pipeline* language, which the server
 * owns — the client never decides what Deepgram listens for.
 */
export const useLocaleStore = create<LocaleState>((set) => ({
  language: "en-GB",
  setLanguage: (language) => set({ language }),
}));

function interpolate(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/** Translate outside a component (event handlers, Alert.alert, helpers). */
export function translate(
  key: string,
  vars?: Record<string, string | number>,
): string {
  const dictionary = DICTIONARIES[useLocaleStore.getState().language];
  return interpolate(dictionary?.[key] ?? key, vars);
}

/** Translate inside a component. Re-renders when the language changes. */
export function useT() {
  const language = useLocaleStore((s) => s.language);
  const dictionary = DICTIONARIES[language];
  return (key: string, vars?: Record<string, string | number>): string =>
    interpolate(dictionary?.[key] ?? key, vars);
}
