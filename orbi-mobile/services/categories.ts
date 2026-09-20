// How spending categories are shown to a person.
//
// The backend stores lowercase slugs — "groceries", "uncategorized" — which
// are the right thing in a database and the wrong thing on a screen. In
// particular "uncategorized" was rendering verbatim next to real category
// names, which reads as a bug rather than as a state: it is jargon, it is the
// longest label in the list so it draws the eye, and it tells the user
// nothing they can act on.
//
// "Other" is the honest version of the same fact. It is what every bank and
// budgeting app calls the bucket, it does not look broken, and it does not
// imply the user failed to do something.

import { translate } from "@/i18n";

/** The slug the backend uses when no merchant rule matched. */
export const UNCATEGORIZED = "uncategorized";

// Keys are the backend's slugs. Values go through translate(), so a category
// the backend adds before this map does still renders readably — it falls
// through to a title-cased version of the slug rather than disappearing.
const LABELS: Record<string, string> = {
  groceries: "Groceries",
  transport: "Transport",
  subscriptions: "Subscriptions",
  dining: "Dining",
  health: "Health",
  finance: "Finance",
  shopping: "Shopping",
  home: "Home",
  [UNCATEGORIZED]: "Other",
};

/** Human label for a category slug. Never returns the raw slug. */
export function formatCategory(slug: string | null | undefined): string {
  if (!slug) return translate("Other");
  const known = LABELS[slug.toLowerCase()];
  if (known) return translate(known);
  // Unknown slug — probably added server-side since this shipped. Title-case
  // it rather than showing "some_new_category" or, worse, nothing.
  return slug
    .split(/[_\-\s]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** True when the backend could not work out where this belongs.
 *
 * Exposed so the UI can treat it as a prompt — "tap to categorise" — rather
 * than as just another category. The label alone cannot carry that, because
 * "Other" is also a legitimate choice a user can make deliberately.
 */
export function isUncategorized(slug: string | null | undefined): boolean {
  return !slug || slug.toLowerCase() === UNCATEGORIZED;
}
