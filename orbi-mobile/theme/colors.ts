// The palettes, and the one object the whole app reads colours from.
//
// WHY THE CLUSTER COLOURS ARE THE ONLY COLOUR
// Chrome is paper and ink; colour is reserved for the thing colour is already
// doing a job for — the clusters. `accent` is ink, so every primary button,
// active chip and the mic read as "the action" without borrowing a hue a
// cluster needs.
//
// HOW NIGHT MODE WORKS WITHOUT EDITING FORTY SCREENS
// 44 files name these keys about 970 times, nearly all inside
// StyleSheet.create, which evaluates once at import. Swapping values on a
// constant would change nothing on screen. So:
//
//   1. `colors` is a single mutable object. applyPalette() overwrites its
//      values in place, so every `colors.ink` read AFTER the swap gets the
//      new value — including inline ones in JSX.
//   2. Stylesheets are wrapped in themed() (theme/themed.ts), which rebuilds
//      them on first read after the palette version changes.
//   3. The navigators remount each screen's CONTENT on a theme change
//      (screenLayout in app/_layout.tsx), so everything re-reads — while the
//      navigation state itself survives, and you stay where you were.
//
// Anything that copies a colour into a module-level constant defeats step 1
// and stays in whichever palette was live at import. Read colours at render.
//
// CONTRAST
// Every text colour clears 4.5:1 on the surface it is meant for, in both
// palettes, and cluster colours differ in lightness as well as hue.

export interface Palette {
  bg: string;
  canvas: string; // universe ground, and the text colour on an accent fill
  panel: string;
  ink: string;
  inkDim: string;
  line: string;
  faint: string; // quieter than line: dashed rings, empty-state strokes
  accent: string;
  work: string;
  health: string;
  finance: string;
  personal: string;
  home: string;
  learning: string;
  drift: string;
  overdue: string;
}

export const light: Palette = {
  bg: "#FBF9F6", // warm paper, not white
  canvas: "#FBF9F6",
  panel: "#FFFFFF",
  ink: "#14161C",
  inkDim: "#6B6F7B", // 4.9:1 on paper
  line: "#E6E2DC",
  faint: "#C9C3B9",
  accent: "#14161C",

  work: "#2B6CB0",
  health: "#15803D",
  finance: "#A16207",
  personal: "#7C3AED",
  home: "#C2410C",
  learning: "#0E7490",
  drift: "#6B7280",

  overdue: "#BE123C",
};

// Night, lifted off black.
//
// The first version of this app was #07080F — near-black and cold, which is
// what made it feel like a void rather than an evening. Night keeps a dark
// ground but sits it higher and a touch warmer, and it brightens the cluster
// colours rather than darkening the ground further: a dark theme feels
// comfortable when the CONTENT glows, not when the background recedes.
//
// Ink inverts to a pale action colour, and `canvas` — used as the text on
// accent fills — inverts with it, so a primary button stays dark-on-light in
// one theme and light-on-dark in the other without either needing a branch.
export const night: Palette = {
  bg: "#121620",
  canvas: "#121620",
  panel: "#1A1F2B",
  ink: "#EEF1F7",
  inkDim: "#98A0B3", // 6.3:1 on the night panel
  line: "#2B3242",
  faint: "#4A5263",
  accent: "#EEF1F7",

  work: "#3B82F6",
  health: "#22A06B",
  finance: "#D4A017",
  personal: "#8B5CF6",
  home: "#EA7A3C",
  learning: "#1BA8C4",
  drift: "#7C8496",

  overdue: "#F0506E",
};

export type ThemeName = "light" | "night";

/** The live palette. Mutated in place by applyPalette — never replaced,
 * because every module already holds a reference to this exact object. */
export const colors: Palette = { ...light };

let version = 0;
let current: ThemeName = "light";

/** Switch the live palette. Returns the new version number. */
export function applyPalette(name: ThemeName): number {
  if (name === current && version > 0) return version;
  Object.assign(colors, name === "night" ? night : light);
  current = name;
  version += 1;
  return version;
}

/** Increments on every palette change; themed() rebuilds on a new value. */
export function paletteVersion(): number {
  return version;
}

export function currentTheme(): ThemeName {
  return current;
}

export type ColorKey = keyof Palette;
