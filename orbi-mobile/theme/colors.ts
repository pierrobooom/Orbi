// The palette.
//
// WHY THE CLUSTER COLOURS ARE THE ONLY COLOUR
// The app used to carry a lavender brand accent (#7C6FE0) on a near-black
// ground, and it painted everything: the mic, the tab bar, every primary
// button, every active chip. That is a seventh colour competing with six
// that already mean something — work, health, finance, personal, home,
// learning — so the ones carrying information had to shout over the one
// carrying none, on a ground too dark for any of them to sit on.
//
// So: chrome is paper and ink, and colour is reserved for the thing colour
// is already doing a job for. `accent` is now ink. Every primary button,
// active chip and mic reads as the action without borrowing a hue that a
// cluster needs.
//
// WHY THE KEYS DID NOT CHANGE
// 44 files import this module and reference these names about 970 times,
// nearly all inside StyleSheet.create, which evaluates once at module load.
// Renaming the keys would mean touching every one of those files to change
// nothing a user can see. Swapping the VALUES turns the whole app light in
// one commit, with no screen left half-converted.
//
// That same fact is why a runtime light/night toggle is a separate piece of
// work rather than a flag here: static styles are captured at import, so a
// toggle needs every screen's styles rebuilt per render. `night` below is
// the palette that work will switch to; nothing reads it yet.
//
// CONTRAST
// Every text colour here clears 4.5:1 on the surface it is meant for, and
// the cluster colours differ in lightness as well as hue so they stay
// distinguishable without relying on colour vision alone.

export const colors = {
  bg:       "#FBF9F6",  // outermost page background — warm paper, not white
  canvas:   "#FBF9F6",  // bubble universe background, and text on ink fills
  panel:    "#FFFFFF",  // cards, sheets, raised surfaces
  ink:      "#14161C",  // primary text
  inkDim:   "#6B6F7B",  // secondary text — 4.9:1 on paper
  line:     "#E6E2DC",  // hairlines and borders
  accent:   "#14161C",  // every primary action. Ink, deliberately: see above

  // Cluster colours, retuned for a light ground. Each is a fill with white
  // text on it inside a bubble, and a dot or bar everywhere else.
  work:     "#2B6CB0",
  health:   "#15803D",
  finance:  "#A16207",
  personal: "#7C3AED",
  home:     "#C2410C",
  learning: "#0E7490",
  drift:    "#6B7280",  // catch-all cluster — neutral grey

  // State overrides
  overdue:  "#BE123C",  // overrides cluster colour, pulses
} as const;

// The night palette, lifted off black.
//
// The old ground was #07080F: near-black and cold, which is what made the
// app feel like a void rather than like evening. Night keeps its dark
// ground but sits it higher and warmer, and brightens the cluster colours
// rather than darkening the surface further — a dark theme reads as
// comfortable when the CONTENT glows, not when the background recedes.
//
// Not wired up yet. See the note at the top about why the toggle is its
// own piece of work.
export const night = {
  bg:       "#121620",
  canvas:   "#121620",
  panel:    "#1A1F2B",
  ink:      "#EEF1F7",
  inkDim:   "#98A0B3",
  line:     "#2B3242",
  accent:   "#EEF1F7",  // ink inverts: a pale action on a dark ground

  work:     "#3B82F6",
  health:   "#34D399",
  finance:  "#FBBF24",
  personal: "#A78BFA",
  home:     "#FB923C",
  learning: "#22D3EE",
  drift:    "#7C8496",

  overdue:  "#FB7185",
} as const;

export type ColorKey = keyof typeof colors;
