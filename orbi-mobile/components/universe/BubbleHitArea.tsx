// Invisible touch target overlay for one bubble in the Skia canvas.
//
// Skia draws bubbles inside a Canvas; React Native gestures can't touch
// Skia nodes because they live in a separate render tree. To make bubbles
// tappable we layer an Animated.Pressable per bubble, positioned by
// useAnimatedStyle that reads from the same physics shared value the
// canvas uses. The overlay tracks the bubble's drift on the UI thread —
// no JS re-renders per frame.
//
// One hook call (useAnimatedStyle) must happen unconditionally, which is
// why this is a component per bubble rather than a loop inside the
// canvas.

import React from "react";
import { Pressable } from "react-native";
import Animated, {
  useAnimatedStyle,
  type SharedValue,
} from "react-native-reanimated";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface PhysicsState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  tx: number;
  ty: number;
  r: number;
  wiggle: number;
}

interface Props {
  index: number;
  physics: SharedValue<PhysicsState[]>;
  // Tap padding — gives the user a generous hit area without making
  // overlapping bubbles steal each other's taps. Roughly 1× the radius
  // outward from the visible edge.
  padding?: number;
  onPress: () => void;
  // Optional secondary gesture — used on the universe canvas so a long
  // press on a cluster bubble opens the cluster editor instead of
  // drilling in. Task bubbles don't pass this through.
  onLongPress?: () => void;
}

export default function BubbleHitArea({ index, physics, padding = 6, onPress, onLongPress }: Props) {
  const overlayStyle = useAnimatedStyle(() => {
    const p = physics.value[index];
    if (!p) {
      return { opacity: 0, width: 0, height: 0 } as const;
    }
    const size = (p.r + padding) * 2;
    return {
      position: "absolute" as const,
      left: p.x - p.r - padding,
      top: p.y - p.r - padding,
      width: size,
      height: size,
    };
  });

  return (
    <AnimatedPressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={overlayStyle}
      accessibilityRole="button"
    />
  );
}
