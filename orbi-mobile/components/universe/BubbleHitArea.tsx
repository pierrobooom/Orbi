// Touch target for one bubble in the Skia canvas — tap, hold, and drag.
//
// Skia draws bubbles inside a Canvas; React Native gestures can't touch Skia
// nodes because they live in a separate render tree. So each bubble gets an
// overlay positioned by useAnimatedStyle reading the same physics shared
// value the canvas draws from. The overlay tracks the bubble's drift on the
// UI thread — no JS re-renders per frame.
//
// PICK UP, THEN MOVE — THE SAME GRAMMAR AS A HOME SCREEN ICON
// A bare pan would fight two things at once: the canvas's own horizontal pan,
// and the tap that opens a bubble. Requiring a hold first separates all three
// cleanly and needs no gesture-ref choreography:
//
//   tap                  → open the bubble
//   swipe                → pan the universe (the hold never completes)
//   hold, then move      → drag the bubble
//   hold, then release   → the old long-press action (cluster editor, move sheet)
//
// That last line is why the long press is handled here rather than left on a
// Pressable: once this gesture has armed at 260ms, the Pressable's own 500ms
// long press would never fire. Reporting it on release preserves the
// behaviour exactly, and matches what a phone does — hold an icon and it
// lifts; let go without moving and you get the menu.
//
// WHY THE PHYSICS IS WRITTEN DIRECTLY
// Everything here runs on the UI thread against a shared value. Routing drag
// positions through JS would put a round trip between the finger and the
// bubble at 120Hz, which is precisely the lag that makes dragging feel cheap.

import * as Haptics from "expo-haptics";
import React from "react";
import {
  Gesture,
  GestureDetector,
  type GestureType,
} from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from "react-native-reanimated";

import type { PhysicsState } from "./types";

interface Props {
  index: number;
  // Identity, so a stale physics array can't move the tap target onto a
  // different bubble — or size it to zero and swallow the tap entirely.
  bubbleId: string;
  // Layout position, always in step with the current bubble list.
  fallback: PhysicsState;
  physics: SharedValue<PhysicsState[]>;
  // Tap padding — gives the user a generous hit area without making
  // overlapping bubbles steal each other's taps. Roughly 1× the radius
  // outward from the visible edge.
  padding?: number;
  onPress: () => void;
  // Fired on a hold that ends without movement. Used on the universe canvas
  // so holding a cluster opens its editor and holding a task opens the
  // move-to-cluster sheet.
  onLongPress?: () => void;
  // The canvas's own horizontal pan. Handed in so the drag can block it:
  // without that, dragging a bubble sideways slides the whole universe
  // underneath it and the bubble appears to stick to the screen.
  canvasPan?: GestureType;
}

// How long before a bubble lifts. Long enough not to trigger while someone
// is flicking the canvas sideways, short enough that "hold" doesn't feel
// like waiting.
const HOLD_MS = 260;

// Movement past this counts as a drag rather than a long press. Below it,
// releasing is treated as the hold action — fingers are never perfectly
// still and a 2px twitch should not change what a gesture meant.
const DRAG_SLOP = 6;

export default function BubbleHitArea({
  index,
  bubbleId,
  fallback,
  physics,
  padding = 6,
  onPress,
  onLongPress,
  canvasPan,
}: Props) {
  // Drives the lift. Kept separate from the physics entry because it is
  // presentation — the bubble's collision radius must not grow just because
  // it looks bigger while held.
  const lift = useSharedValue(0);
  const moved = useSharedValue(0);
  // Where the bubble was when it was picked up. Declared before the gesture
  // that reads it: a worklet captures its closure when it is built, so a
  // shared value defined further down the function body is simply not there.
  const grabbed = useSharedValue({ x: 0, y: 0 });

  /** The index of this bubble in the physics array, resolved by id.
   *
   * The array can be one render stale after a resync, and writing to the
   * wrong slot would drag somebody else's bubble. */
  const resolve = (): number => {
    "worklet";
    const byIndex = physics.value[index];
    if (byIndex && byIndex.id === bubbleId) return index;
    return physics.value.findIndex((e) => e.id === bubbleId);
  };

  const tap = Gesture.Tap()
    .maxDuration(HOLD_MS)
    .onEnd((_e, success) => {
      "worklet";
      if (success) runOnJS(onPress)();
    });

  let drag = Gesture.Pan()
    .activateAfterLongPress(HOLD_MS)
    .onStart(() => {
      "worklet";
      const i = resolve();
      if (i < 0) return;
      const next = physics.value.slice();
      next[i] = { ...next[i], dragging: 1, vx: 0, vy: 0 };
      physics.value = next;
      // Anchor the drag to where the bubble actually is at pick-up. Using
      // the layout position instead would make it jump the moment it lifts,
      // since the simulation has been drifting it around for minutes.
      grabbed.value = { x: next[i].x, y: next[i].y };
      moved.value = 0;
      lift.value = withSpring(1, { damping: 14, stiffness: 180 });
      // The moment of pick-up is the one piece of feedback that says "you
      // now have hold of this" before anything has visibly moved.
      runOnJS(Haptics.impactAsync)(Haptics.ImpactFeedbackStyle.Medium);
    })
    .onUpdate((e) => {
      "worklet";
      const i = resolve();
      if (i < 0) return;
      if (Math.abs(e.translationX) + Math.abs(e.translationY) > DRAG_SLOP) {
        moved.value = 1;
      }
      const next = physics.value.slice();
      // Absolute, not incremental: translation is measured from where the
      // finger started, so accumulating deltas would drift away from the
      // touch over a long drag.
      next[i] = {
        ...next[i],
        x: grabbed.value.x + e.translationX,
        y: grabbed.value.y + e.translationY,
      };
      physics.value = next;
    })
    .onEnd(() => {
      "worklet";
      const i = resolve();
      lift.value = withSpring(0, { damping: 15, stiffness: 200 });
      if (i < 0) return;
      const next = physics.value.slice();
      const b = next[i];
      // Where it lands becomes where it lives: the anchor moves to the drop
      // point, so the bubble now orbits here instead of drifting back. Any
      // velocity is discarded — a bubble that was placed should stay put,
      // not coast.
      next[i] = moved.value
        ? { ...b, dragging: 0, vx: 0, vy: 0, tx: b.x, ty: b.y, placed: 1 }
        : { ...b, dragging: 0 };
      physics.value = next;

      if (!moved.value && onLongPress) runOnJS(onLongPress)();
    })
    .onFinalize(() => {
      "worklet";
      // A cancelled gesture — a call arriving, a second finger — must still
      // release the bubble, or it hangs frozen out of the simulation.
      const i = resolve();
      if (i < 0) return;
      if (physics.value[i].dragging) {
        const next = physics.value.slice();
        next[i] = { ...next[i], dragging: 0 };
        physics.value = next;
      }
      lift.value = withSpring(0, { damping: 15, stiffness: 200 });
    });

  if (canvasPan) drag = drag.blocksExternalGesture(canvasPan);

  // Exclusive: a hold that becomes a drag must not also register as a tap.
  // blocksExternalGesture stops the canvas's own horizontal pan from
  // running at the same time — without it, dragging a bubble sideways
  // slides the whole universe under it.
  const gesture = Gesture.Exclusive(drag, tap);

  const overlayStyle = useAnimatedStyle(() => {
    const byIndex = physics.value[index];
    let p =
      byIndex && byIndex.id === bubbleId
        ? byIndex
        : physics.value.find((e) => e.id === bubbleId);
    // Never collapse to zero size: that silently ate every tap on this
    // bubble until the subtree remounted.
    if (!p) p = fallback;
    const size = (p.r + padding) * 2;
    return {
      position: "absolute" as const,
      left: p.x - p.r - padding,
      top: p.y - p.r - padding,
      width: size,
      height: size,
      // Grows under the finger. The canvas draws the circle; this is the
      // touch target, so scaling it also widens the grab area slightly,
      // which is what you want once something is already in hand.
      transform: [{ scale: 1 + lift.value * 0.25 }],
      zIndex: p.dragging ? 10 : 0,
    };
  });

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={overlayStyle} accessibilityRole="button" />
    </GestureDetector>
  );
}
