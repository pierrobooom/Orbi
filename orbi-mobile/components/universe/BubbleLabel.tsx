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

const styles = StyleSheet.create({
  // A light shadow, not the heavy 70% one this used to carry. That was
  // there to lift white text off pale fills against a black universe; the
  // retuned cluster colours are all deep enough to hold white on their
  // own, and a thick dark halo round every letter reads as smudged on
  // paper. What is left is just enough to separate small text from the
  // brightest fills.
  label: {
    color: "white",
    fontSize: 11,
    fontWeight: "600",
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.22)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  dominantLabel: {
    color: "white",
    fontSize: 14,
    fontWeight: "700",
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.22)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  // Same colour and family as the title, a step smaller and lighter.
  //
  // It used to be colors.ink at 85% — a light grey chosen for a dark ground.
  // Once the palette flipped, ink became near-black, so the count under
  // every cluster name turned into dark text on a coloured fill. One voice
  // for both lines also reads as a single label rather than as a name with
  // a caption stuck to it.
  subtitle: {
    color: "white",
    fontSize: 11,
    fontWeight: "500",
    textAlign: "center",
    opacity: 0.9,
    marginTop: 1,
    textShadowColor: "rgba(0,0,0,0.22)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  muted: {
    color: colors.inkDim,
    textShadowColor: "transparent",
    opacity: 1,
  },
});
