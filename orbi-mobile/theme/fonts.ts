// Typefaces beyond the system font.
//
// ONE display face, used for a handful of big numbers and nowhere else.
// The interface stays in the platform font — it is free, it is what the OS
// renders its own controls in, and it disappears in the way body text
// should. Personality goes where the eye lands first: the figure at the top
// of a money screen.
//
// Imported by weight subpath below, not from the package root. The root
// index requires every weight, and Metro bundles every file it sees
// required — eighteen font files shipped to use one.

import { Fraunces_600SemiBold } from "@expo-google-fonts/fraunces/600SemiBold";

/** The family name to put in a style's fontFamily. */
export const DISPLAY = "Fraunces_600SemiBold";

/** What app/_layout.tsx hands to useFonts. */
export const FONT_ASSETS = { Fraunces_600SemiBold };
