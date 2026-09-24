// The user's face, small, wherever the app needs to point at "you".
//
// WHY A PICTURE RATHER THAN A PERSON GLYPH
// A generic silhouette is the same on every device, which makes it a
// decoration rather than a control — nothing about it says the tap leads to
// YOUR account. A photograph is the most recognisable thing on a screen and
// the one element a person can identify without reading.
//
// The fallback is initials, not the silhouette that was there before, for
// the same reason: initials differ per person, so they still say whose
// account this is.

import { Image } from "expo-image";
import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { colors } from "@/theme/colors";

interface Props {
  url: string | null;
  /** Used for the initials fallback. */
  name: string;
  size?: number;
}

/** Up to two initials, upper-cased. Falls back to a dot rather than a
 * letter when there is no name at all, because a stray "?" reads as an
 * error state rather than as an empty one. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "·";
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar({ url, name, size = 30 }: Props) {
  const box = {
    width: size,
    height: size,
    borderRadius: size / 2,
  };

  if (url) {
    return (
      <Image
        source={{ uri: url }}
        style={[box, styles.ring]}
        contentFit="cover"
        // The URL changes whenever the picture does — the stored object is
        // named randomly — so a long cache can never show a stale face.
        cachePolicy="memory-disk"
        transition={120}
        accessibilityIgnoresInvertColors
      />
    );
  }

  return (
    <View style={[box, styles.ring, styles.initialsBox]}>
      <Text style={[styles.initials, { fontSize: size * 0.4 }]}>
        {initialsOf(name)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // A hairline so a light photograph still reads as a distinct object
  // against the paper ground rather than bleeding into it.
  ring: { borderWidth: 1, borderColor: colors.line },
  initialsBox: {
    backgroundColor: colors.panel,
    alignItems: "center",
    justifyContent: "center",
  },
  initials: { color: colors.inkDim, fontWeight: "700" },
});
