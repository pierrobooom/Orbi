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

interface PhysicsState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  tx: number;
  ty: number;
  r: number;
  wiggle: number;
  orbitR: number;
  phaseX: number;
  phaseY: number;
  freqX: number;
  freqY: number;
}

interface Props {
  index: number;
  label: string;
  physics: SharedValue<PhysicsState[]>;
  // Bigger label for dominant bubbles (cluster name); smaller for the
  // per-bubble task title.
  size?: "dominant" | "normal";
  subtitle?: string;
}

const LABEL_WIDTH = 120; // wide enough for our truncated label; centered

export default function BubbleLabel({ index, label, physics, size = "normal", subtitle }: Props) {
  const containerStyle = useAnimatedStyle(() => {
    const p = physics.value[index];
    if (!p) return { opacity: 0 } as const;
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
        style={size === "dominant" ? styles.dominantLabel : styles.label}
        // text shadow handles contrast against bright cluster colors
      >
        {label}
      </Text>
      {subtitle ? (
        <Text numberOfLines={1} style={styles.subtitle}>
          {subtitle}
        </Text>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  label: {
    color: "white",
    fontSize: 11,
    fontWeight: "600",
    textAlign: "center",
    // Cheap 1px black outline via textShadow — readable on every
    // cluster color including the bright ones.
    textShadowColor: "rgba(0,0,0,0.7)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  dominantLabel: {
    color: "white",
    fontSize: 13,
    fontWeight: "700",
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.7)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  subtitle: {
    color: colors.ink,
    fontSize: 10,
    fontWeight: "400",
    textAlign: "center",
    opacity: 0.85,
    marginTop: 1,
    textShadowColor: "rgba(0,0,0,0.7)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
});
