// RN-side text overlay for one bubble.
//
// Skia's <Text> with matchFont is the "native" way to draw labels inside
// Canvas, but small font sizes + the empty fontFamily fallback don't
// always render on iOS. To make labels reliable we paint them with a
// plain RN <Text> in an Animated.View, positioned absolutely on the UI
// thread via useAnimatedStyle reading from the same physics shared
// value the canvas reads. No JS re-renders per frame.

import React from "react";
import { StyleSheet, Text } from "react-native";
import Animated, {
  useAnimatedStyle,
  type SharedValue,
} from "react-native-reanimated";

import { colors } from "@/theme/colors";
import type { PhysicsState } from "./types";

interface Props {
  index: number;
  // Identity, so a stale physics array can't hand us the wrong bubble.
  bubbleId: string;
  // Layout position for this bubble, always in step with the current
  // bubble list. Used when the physics array has not caught up yet.
  fallback: PhysicsState;
  label: string;
  physics: SharedValue<PhysicsState[]>;
  // Bigger label for dominant bubbles (cluster name); smaller for the
  // per-bubble task title.
  size?: "dominant" | "normal";
  subtitle?: string;
  // "light" is white text on a coloured fill — every bubble but one.
  // "muted" is for Adrift, which is drawn as an empty dashed ring on the
  // paper ground: white text there would be invisible.
  tone?: "light" | "muted";
}

const LABEL_WIDTH = 120; // wide enough for our truncated label; centered

export default function BubbleLabel({
  index,
  bubbleId,
  fallback,
  label,
  physics,
  size = "normal",
  subtitle,
  tone = "light",
}: Props) {
  const muted = tone === "muted";
  const containerStyle = useAnimatedStyle(() => {
    // Index first as a fast path, but only trust it when the entry is
    // actually this bubble's. Otherwise scan, and fall back to the
    // layout anchor rather than hiding — an invisible label is how this
    // went unnoticed the first time.
    const byIndex = physics.value[index];
    let p =
      byIndex && byIndex.id === bubbleId
        ? byIndex
        : physics.value.find((e) => e.id === bubbleId);
    if (!p) p = fallback;
    return {
      position: "absolute" as const,
      left: p.x - LABEL_WIDTH / 2,
      top: p.y - 12,
      width: LABEL_WIDTH,
    };
  });

  return (
    <Animated.View pointerEvents="none" style={containerStyle}>
      <Text
        numberOfLines={1}
        style={[
          size === "dominant" ? styles.dominantLabel : styles.label,
          muted && styles.muted,
        ]}
      >
        {label}
      </Text>
      {subtitle ? (
        <Text numberOfLines={1} style={[styles.subtitle, muted && styles.muted]}>
          {subtitle}
        </Text>
      ) : null}
    </Animated.View>
  );
}

// A thin, even outline round every letter.
//
// Zero offset is what makes it an outline rather than a shadow: the halo
// sits equally on all sides, so it hugs the glyph instead of dropping away
// from it. It is there for the light fills — a lime or cyan cluster is
// bright enough that white on it all but disappears, and clusters can be
// any colour their owner chose.
//
// 60% with a one-pixel drop. The first pass (45%, no offset) was an even
// halo that still let white letters dissolve into lime and cyan. The small
// downward offset adds a shadow on top of the outline — the text now sits
// slightly above the fill rather than on it, which is what makes it read
// against a pale colour — while the radius still wraps every side.
const OUTLINE = {
  textShadowColor: "rgba(20, 22, 28, 0.6)",
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 3.5,
} as const;

const styles = StyleSheet.create({
  label: {
    color: "white",
    fontSize: 11,
    fontWeight: "600",
    textAlign: "center",
    ...OUTLINE,
  },
  dominantLabel: {
    color: "white",
    fontSize: 14,
    fontWeight: "700",
    textAlign: "center",
    ...OUTLINE,
  },
  // Same colour and family as the title, a step smaller and lighter. It was
  // once colors.ink, chosen as a light grey for a dark ground — which turned
  // near-black when the palette flipped.
  subtitle: {
    color: "white",
    fontSize: 11,
    fontWeight: "500",
    textAlign: "center",
    opacity: 0.95,
    marginTop: 1,
    ...OUTLINE,
  },
  // Adrift's hollow ring sits on the paper ground, so its text is grey and
  // needs no outline at all.
  muted: {
    color: colors.inkDim,
    textShadowColor: "transparent",
    opacity: 1,
  },
});
