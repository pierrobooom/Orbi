// Bubble universe canvas — state 1 from orbi_mobile_sketch.html.
//
// Each bubble has a shared physics state. A useFrameCallback worklet runs
// on the UI thread every frame and applies three forces:
//   1. cluster spring   — pull toward the bubble's cluster center
//   2. Brownian wiggle  — small random drift, amplitude scaled by pressure
//   3. damping          — prevents runaway oscillation
//
// Forces 1+2 are how clusters stay coherent while never being fully still.
// Higher pressure_score = bigger wiggle, so urgent bubbles read as restless
// even before you notice their size or color.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import {
  Canvas,
  Circle,
  Group,
} from "@shopify/react-native-skia";
import Animated, {
  Easing,
  Keyframe,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  useDerivedValue,
  useFrameCallback,
  withDecay,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import { colors } from "@/theme/colors";
import { useUniverseStore } from "@/stores/universeStore";
import BubbleHitArea from "./BubbleHitArea";
import BubbleLabel from "./BubbleLabel";
import StarField from "./StarField";
import type { Cluster, Bubble } from "./types";

interface PhysicsState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  // The per-bubble target the spring force pulls toward. Each non-
  // dominant bubble settles at its own orbital spot around the cluster
  // center; without this, every bubble would spring back to the shared
  // cluster center and they'd all overlap.
  tx: number;
  ty: number;
  r: number;
  wiggle: number;
}

function pressureToRadius(p: number): number {
  "worklet";
  // Baseline 16px (low-pressure / default tasks), max ~24px at
  // pressure 10. Roughly 1.5x growth — gentle and easy to compare
  // at a glance.
  return 16 + (Math.max(0, Math.min(10, p)) / 10) * 8;
}

// Overdue bubbles get a flat size boost on top of pressure-based sizing
// so they read as physically chunkier, not just animated. The breathing
// pulse on top of this still works.
const OVERDUE_RADIUS_BOOST = 4;

// Bubbles are tiny (radius 10–36px); long titles overflow as a single
// glyph run because Skia text doesn't wrap. We extract a short label
// from the title — preferring distinctive content words ("Mercedes",
// "rent") over generic verbs and stop words ("call", "the", "about").
//
// Algorithm:
//   1. If the whole title fits in `maxChars`, return it unchanged.
//   2. Otherwise filter out stop words and low-signal verbs, keep the
//      remaining content words.
//   3. Walk that list and accumulate words until we'd exceed maxChars.
//   4. Fall back to plain truncation if filtering left us with nothing.
//
// "Call Mercedes about the car warranty" → "Mercedes car warranty" →
// truncated to fit → "Mercedes car…"
const _STOP_WORDS = new Set([
  "a", "an", "the", "to", "from", "about", "of", "for", "with",
  "and", "or", "in", "on", "at", "by", "as", "is", "was", "are",
  "be", "been", "this", "that", "these", "those", "my", "your",
  "i", "im", "i'm", "ive", "i've",
]);
const _LOW_SIGNAL_VERBS = new Set([
  "call", "buy", "go", "send", "email", "remind", "make", "do",
  "get", "have", "take", "pick", "drop", "visit", "see", "check",
  "need", "want", "should", "must", "gotta", "going", "gonna",
]);

function shortLabel(title: string, maxChars: number = 14): string {
  const trimmed = title.trim();
  if (!trimmed) return trimmed;
  if (trimmed.length <= maxChars) return trimmed;

  const words = trimmed.split(/\s+/);
  const content = words.filter((w) => {
    const lower = w.toLowerCase().replace(/[^a-z0-9']/g, "");
    if (!lower) return false;
    if (_STOP_WORDS.has(lower)) return false;
    if (_LOW_SIGNAL_VERBS.has(lower)) return false;
    return true;
  });

  // Pick from the filtered list first; if filtering nuked everything
  // (e.g. title is "Call the dentist" → only "dentist" survives) we
  // still try to use what we have. If nothing survives, fall back.
  const pickFrom = content.length > 0 ? content : words;
  let out = "";
  for (const w of pickFrom) {
    const candidate = out ? `${out} ${w}` : w;
    if (candidate.length > maxChars - 1) break;
    out = candidate;
  }
  if (!out) out = trimmed.slice(0, maxChars);
  // No ellipsis — the bubble's small size already signals truncation,
  // and the dots steal precious character budget from real content.
  return out;
}

// Resolve a bubble's display radius. Cluster bubbles carry an
// explicit `radius` (set by the layout pass from sqrt(task count));
// task bubbles fall back to the pressure-based calc. Overdue boost
// only applies in task mode — pulsing the whole cluster bubble would
// be noisy when many clusters have at least one overdue task.
function radiusFor(b: Bubble): number {
  if (b.radius !== undefined) return b.radius;
  return pressureToRadius(b.pressureScore) + (b.overdue ? OVERDUE_RADIUS_BOOST : 0);
}

function buildInitialStates(
  bubbles: Bubble[],
  clusters: Cluster[],
  width: number,
  height: number,
): PhysicsState[] {
  return bubbles.map((b) => {
    const cluster = clusters.find((c) => c.id === b.clusterId)!;
    const cx = cluster.centerX * width;
    const cy = cluster.centerY * height;
    const tx = cx + b.offsetX;
    const ty = cy + b.offsetY;
    return {
      x: tx,
      y: ty,
      vx: 0,
      vy: 0,
      tx,
      ty,
      // r is the collision radius — include the overdue boost so the
      // physics hitbox matches what the user sees.
      r: radiusFor(b),
      // Brownian amplitude. Cluster bubbles drift more slowly than
      // tasks (lower per-frame wiggle) so the top-level view feels
      // calm and inspectable.
      wiggle: b.kind === "cluster"
        ? 0.08
        : 0.14 + (b.pressureScore / 10) * 0.3,
    };
  });
}

interface BubbleCanvasProps {
  // Called when the user taps a task bubble. Receives the underlying
  // task id (which is also the bubble id — they're one-to-one).
  // Optional so the canvas remains usable in read-only contexts.
  onBubbleTap?: (taskId: string) => void;
  // Called when the user long-presses a CLUSTER bubble (top-level
  // view). The universe screen wires this up to open the cluster
  // editor. Long-press on a task bubble is intentionally ignored.
  onClusterLongPress?: (clusterId: string) => void;
  // Long-press on a TASK bubble (drilled view). Used for "move to
  // cluster" — the two-level universe never shows a task and a
  // destination cluster together, so drag-and-drop isn't available.
  onTaskLongPress?: (taskId: string) => void;
  // Called when the user taps the pencil in the drilled-view back
  // overlay. Lets the parent open the cluster editor for the
  // currently focused cluster without the canvas needing to know
  // about navigation.
  onEditFocusedCluster?: (clusterId: string) => void;
}

export default function BubbleCanvas({ onBubbleTap, onClusterLongPress, onTaskLongPress, onEditFocusedCluster }: BubbleCanvasProps = {}) {
  const { width, height } = useWindowDimensions();
  // Approximate canvas height — leaves room for the header strip + tab bar.
  // Actual layout will be tightened once those components ship.
  const canvasHeight = Math.max(360, height - 180);

  const clusters = useUniverseStore((s) => s.clusters);
  const bubbles = useUniverseStore((s) => s.bubbles);
  const activeClusterId = useUniverseStore((s) => s.activeClusterId);
  const enterCluster = useUniverseStore((s) => s.enterCluster);
  const exitCluster = useUniverseStore((s) => s.exitCluster);
  const searchQuery = useUniverseStore((s) => s.searchQuery);
  const searchResults = useUniverseStore((s) => s.searchResults);
  const clearSearch = useUniverseStore((s) => s.clearSearch);
  const searchActive = searchResults !== null;
  const matchCount = searchResults?.length ?? 0;

  // The drilled view shows the focused cluster's name + back arrow at
  // the top of the canvas. When active, taps on cluster bubbles open
  // that cluster's task view; otherwise they open the task detail.
  const focusedCluster = activeClusterId
    ? clusters.find((c) => c.id === activeClusterId) ?? null
    : null;

  // ----- Zoom transition --------------------------------------------------
  // We rely on Reanimated layout animations. The wrapping Animated.View
  // is keyed on activeClusterId, so when the view changes the OLD
  // subtree plays its exiting keyframe and unmounts cleanly while the
  // NEW subtree mounts fresh with its own physics state — no shared
  // state to go stale between them.
  //
  // We DO need to gate taps for the animation window: with crossfade,
  // a rapid second tap before the first transition finishes leaves
  // multiple subtrees stacked, and their hit areas / labels conflict
  // with each other. The ref-based guard below drops any tap that
  // arrives while a transition is still in flight.
  const enterAnimation = useMemo(
    () =>
      new Keyframe({
        0:   { opacity: 0, transform: [{ scale: 0.78 }] },
        100: { opacity: 1, transform: [{ scale: 1    }] },
      }).duration(280),
    [],
  );
  const exitAnimation = useMemo(
    () =>
      new Keyframe({
        0:   { opacity: 1, transform: [{ scale: 1    }] },
        100: { opacity: 0, transform: [{ scale: 1.25 }] },
      }).duration(220),
    [],
  );

  // ----- Universe pan (horizontal scroll + elastic edges) --------------
  // The universe is 120% of the screen width — 10% margin on each side
  // populated by stars so the canvas always feels a little bigger than
  // what fits in view. As the cluster count grows, future code can
  // bump `universeWidth` higher and the gesture math below scales
  // automatically. The math:
  //   - target = pan-start offset + finger translation
  //   - inside the bounds [-maxPan, maxPan], panX tracks target 1:1
  //   - past a bound, the overshoot is tanh-clamped to ~60px so the
  //     stretch feels rubbery and has a clear ceiling
  //   - on release, withSpring pulls panX back to the nearest bound
  const universeWidth = width * 1.2;
  const overshoot = (universeWidth - width) / 2;
  const maxPan = overshoot;
  const ELASTIC_LIMIT = 60;

  const panX = useSharedValue(0);
  const panStart = useSharedValue(0);

  const pan = Gesture.Pan()
    .activeOffsetX([-10, 10]) // don't fight per-bubble taps
    .onStart(() => {
      "worklet";
      panStart.value = panX.value;
    })
    .onUpdate((e) => {
      "worklet";
      // Linear elastic — fingers feel the resistance after the bound,
      // but the math is just a fixed-ratio reduction instead of tanh.
      // tanh is fine but at 120Hz touch sampling the cheaper version
      // adds up on the UI thread budget.
      const target = panStart.value + e.translationX;
      if (target > maxPan) {
        const overshoot = target - maxPan;
        panX.value = maxPan + Math.min(ELASTIC_LIMIT, overshoot * 0.35);
      } else if (target < -maxPan) {
        const overshoot = -maxPan - target;
        panX.value = -maxPan - Math.min(ELASTIC_LIMIT, overshoot * 0.35);
      } else {
        panX.value = target;
      }
    })
    .onEnd((e) => {
      "worklet";
      // Single-stage decay with built-in rubber band at the clamp.
      // Reanimated handles the elastic + spring-back internally; no
      // need to chain a second animation, which keeps the worklet
      // count low and the flick frame rate steady.
      const VELOCITY_CAP = 700;
      const capped =
        Math.sign(e.velocityX) *
        Math.min(Math.abs(e.velocityX), VELOCITY_CAP);
      panX.value = withDecay({
        velocity: capped,
        deceleration: 0.985,
        clamp: [-maxPan, maxPan],
        rubberBandEffect: true,
        rubberBandFactor: 0.65,
      });
    });

  const panStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: panX.value }],
  }));

  // Reset pan whenever we enter / exit a cluster — keeps drilled view
  // centered and gives a clean canvas when returning to top-level.
  // withTiming + ease-out so there's no bouncy spring at the end.
  useEffect(() => {
    panX.value = withTiming(0, {
      duration: 320,
      easing: Easing.out(Easing.cubic),
    });
  }, [activeClusterId, panX]);

  // Show a small "re-center" pill any time the user has moved the
  // canvas more than ~20px from origin. Inspired by Google Maps. Only
  // surfaces in the top-level cluster view (the drilled view doesn't
  // pan, so the pill would be a no-op).
  const [showRecenter, setShowRecenter] = useState(false);
  useAnimatedReaction(
    () => Math.abs(panX.value) > 20,
    (current, previous) => {
      if (current !== previous) {
        runOnJS(setShowRecenter)(current);
      }
    },
    [],
  );
  const recenter = () => {
    // Pure ease-out deceleration into the center — no spring bounce.
    // Cubic easing gives a clearly visible slowdown as it approaches
    // 0, matching the "decelerating toward the middle" feel.
    panX.value = withTiming(0, {
      duration: 420,
      easing: Easing.out(Easing.cubic),
    });
  };

  // Slightly longer than the longest animation (280ms enter) so the
  // crossfade fully resolves before another transition can start.
  const TRANSITION_LOCK_MS = 320;
  const transitioningRef = useRef(false);
  const guardedEnter = (clusterId: string) => {
    if (transitioningRef.current) return;
    transitioningRef.current = true;
    enterCluster(clusterId);
    setTimeout(() => {
      transitioningRef.current = false;
    }, TRANSITION_LOCK_MS);
  };
  const guardedExit = () => {
    if (transitioningRef.current) return;
    transitioningRef.current = true;
    exitCluster();
    setTimeout(() => {
      transitioningRef.current = false;
    }, TRANSITION_LOCK_MS);
  };

  return (
    <View style={styles.root}>
     {/* Pan wrapper sits OUTSIDE the keyed animated view so the
         pan offset survives the zoom transition (panning while you
         enter a cluster would otherwise reset awkwardly). Drilled
         view is centered (the useEffect above springs panX to 0). */}
     <GestureDetector gesture={pan}>
      <Animated.View style={[StyleSheet.absoluteFill, panStyle]}>
       <Animated.View
         // Key changes whenever the visible "mode" changes: cluster
         // (top), drilled into one cluster, or search-results view.
         // The keyed remount is what gives the matched-bubbles
         // pull-into-centre animation AND what cleanly resets the
         // BubbleField's physics state — without keying on search,
         // clearing the pill left labels + hit areas stale because
         // the same BubbleField instance kept its previous physics
         // array indexed against the old bubble set.
         key={activeClusterId ?? (searchActive ? "search" : "top")}
         entering={enterAnimation}
         exiting={exitAnimation}
         style={StyleSheet.absoluteFill}
       >
       {/* BubbleField owns its OWN physics shared value. The keyed
           Animated.View wrapper means each view (cluster or drilled)
           gets a fresh BubbleField instance with its own physics — no
           shared-state leakage between the exiting and entering
           subtrees that piled up labels / hit areas in earlier
           iterations of this layout. */}
       <BubbleField
         bubbles={bubbles}
         clusters={clusters}
         width={width}
         universeWidth={universeWidth}
         // Star field extends 20% past the universe on each side
         // (well, 10% per side for 20% total beyond the universe).
         // The Skia Canvas is sized to this so stars can render in
         // the margin past the pan barrier — visible as the user hits
         // the elastic edge and peeks past the universe boundary.
         starFieldWidth={universeWidth * 1.2}
         canvasHeight={canvasHeight}
         onBubblePress={(bubble) => {
           if (bubble.kind === "cluster") {
             guardedEnter(bubble.id);
           } else if (onBubbleTap) {
             onBubbleTap(bubble.id);
           }
         }}
         onBubbleLongPress={(bubble) => {
           // Cluster bubbles (top view) open the cluster editor; task
           // bubbles (drilled view) open the move-to-cluster sheet.
           if (bubble.kind === "cluster") {
             if (onClusterLongPress) onClusterLongPress(bubble.id);
           } else if (onTaskLongPress) {
             onTaskLongPress(bubble.id);
           }
         }}
       />
       </Animated.View>
      </Animated.View>
     </GestureDetector>
      {/* Search-result pill — visible whenever a search is active. Sits
          top-center, shows the query + match count, tap to clear. */}
      {searchActive ? (
        <Pressable
          onPress={clearSearch}
          style={[
            styles.searchPill,
            focusedCluster && styles.searchPillDrilled,
          ]}
          hitSlop={8}
          accessibilityLabel="Clear search"
        >
          <MaterialIcons name="search" size={14} color={colors.ink} />
          <Text style={styles.searchPillText} numberOfLines={1}>
            {`"${searchQuery}" — ${matchCount} ${matchCount === 1 ? "match" : "matches"}`}
          </Text>
          <View style={styles.searchPillClear}>
            <MaterialIcons name="close" size={14} color={colors.inkDim} />
          </View>
        </Pressable>
      ) : null}
      {/* Re-center pill — only when the user has panned non-trivially.
          Lives outside the GestureDetector so taps on it always work,
          and outside the keyed wrapper so it doesn't crossfade. */}
      {showRecenter ? (
        <Pressable
          onPress={recenter}
          style={[
            styles.recenterBtn,
            // Drop below whichever chrome is occupying the top slot:
            // the back overlay when drilled, OR the search pill when
            // a search is active. They both sit at top: 10 by default.
            (focusedCluster || searchActive) && styles.recenterBtnShifted,
          ]}
          hitSlop={8}
          accessibilityLabel="Re-center universe"
        >
          <MaterialIcons name="my-location" size={16} color={colors.ink} />
          <Text style={styles.recenterText}>Re-center</Text>
        </Pressable>
      ) : null}
      {/* Back overlay — only visible in drilled view. Lives OUTSIDE
          the animated wrapper so it remains tappable through any
          residual transform; it triggers its own animated exit. */}
      {/* Drilled view with no tasks — render a centered hint so the
          screen isn't blank apart from the back overlay. */}
      {focusedCluster && bubbles.length === 0 ? (
        <View pointerEvents="none" style={styles.emptyClusterHint}>
          <Text style={styles.emptyClusterTitle}>No tasks here yet</Text>
          <Text style={styles.emptyClusterBody}>
            Add one with the + button. New tasks find their own cluster
            automatically based on what you say.
          </Text>
        </View>
      ) : null}
      {focusedCluster ? (
        <View style={styles.backOverlay}>
          <Pressable
            onPress={guardedExit}
            style={styles.backOverlayBack}
            hitSlop={8}
            accessibilityLabel="Back to clusters"
          >
            <MaterialIcons name="chevron-left" size={22} color={colors.ink} />
            <Text style={styles.backOverlayText} numberOfLines={1}>
              {focusedCluster.name}
            </Text>
          </Pressable>
          {/* Pencil sits next to the cluster name so editing the
              cluster you're inside is discoverable (long-press from
              the top level still works too). Drift can't be edited
              so we hide the pencil there. */}
          {focusedCluster.kind !== "drift" && onEditFocusedCluster ? (
            <Pressable
              onPress={() => onEditFocusedCluster(focusedCluster.id)}
              hitSlop={10}
              style={styles.backOverlayPencil}
              accessibilityLabel="Edit cluster"
            >
              <MaterialIcons name="edit" size={16} color={colors.inkDim} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// BubbleField — physics + rendering for a single view's bubble set
// ---------------------------------------------------------------------------
//
// Pulled out from BubbleCanvas so each keyed instance of the wrapping
// Animated.View gets its OWN physics shared value, useFrameCallback,
// and overlay hit areas. The previous monolithic version kept physics
// at the BubbleCanvas level, which meant the exiting and entering
// subtrees both read from the same shared array — so the exiting
// subtree's hit areas would stick around at wrong positions while the
// new one mounted, intercepting taps and hiding labels. Putting
// physics inside this child component scope means a fresh mount = a
// clean physics array, every time.

interface BubbleFieldProps {
  bubbles: Bubble[];
  clusters: Cluster[];
  width: number;
  universeWidth: number;
  // Width of the star field, which can be wider than the universe so
  // stars exist past the pan barrier. Stars draw across this whole
  // span; bubbles stay confined to the universe range.
  starFieldWidth: number;
  canvasHeight: number;
  onBubblePress: (bubble: Bubble) => void;
  onBubbleLongPress?: (bubble: Bubble) => void;
}

function BubbleField({
  bubbles,
  clusters,
  width,
  universeWidth,
  starFieldWidth,
  canvasHeight,
  onBubblePress,
  onBubbleLongPress,
}: BubbleFieldProps) {
  // The Skia Canvas is sized to the FULL STAR FIELD (which is wider
  // than the universe) and shifted left so the universe is centered
  // on screen when pan = 0. Stars draw across the entire canvas in
  // canvas-local coords; bubble physics is in screen-local coords,
  // so bubbles add `drawOffsetX` to map into canvas-local coords.
  // The RN-side overlays (labels / hit areas) live outside the
  // Canvas in the screen-sized pan wrapper and use physics coords
  // directly — bubble visual, label, and tap target stay aligned at
  // the same screen position regardless of how wide the canvas is.
  const canvasLeftOffset = (starFieldWidth - width) / 2;
  // Universe sits centered within the star field, so bubbles draw at
  // (physics.x + canvasLeftOffset). This is the screen→canvas shift.
  const bubbleDrawOffsetX = canvasLeftOffset;
  const initial = useMemo(
    () => buildInitialStates(bubbles, clusters, width, canvasHeight),
    [bubbles, clusters, width, canvasHeight],
  );

  // Each BubbleField instance owns its own physics state. When the
  // parent's keyed Animated.View remounts on view change, this whole
  // component remounts and the shared value resets from initial.
  const physics = useSharedValue<PhysicsState[]>(initial);
  const lastSyncedIds = useRef<string[]>(bubbles.map((b) => b.id));

  // Resync physics when bubbles change WITHIN the same view (e.g., a
  // new task arrives while the user is in cluster view). Preserves
  // in-flight positions for bubbles whose ids match the previous pass.
  useEffect(() => {
    const prev = physics.value;
    const prevIds = lastSyncedIds.current;
    const next = initial.map((init, i) => {
      const id = bubbles[i].id;
      const prevIdx = prevIds.indexOf(id);
      if (prevIdx >= 0 && prev[prevIdx]) {
        return {
          x: prev[prevIdx].x,
          y: prev[prevIdx].y,
          vx: prev[prevIdx].vx,
          vy: prev[prevIdx].vy,
          tx: init.tx,
          ty: init.ty,
          r: init.r,
          wiggle: init.wiggle,
        };
      }
      return init;
    });
    physics.value = next;
    lastSyncedIds.current = bubbles.map((b) => b.id);
  }, [initial, bubbles, physics]);

  const tickMs = useSharedValue<number>(0);

  useFrameCallback((info) => {
    "worklet";
    const dt = info.timeSincePreviousFrame ?? 16;
    if (!dt) return;
    tickMs.value += dt;
    const step = Math.min(dt / 16, 2);
    const next = physics.value.slice();

    // Spring + wiggle + damping + integrate
    const springK = 0.0016;
    const damping = 0.95;
    const wiggleScale = 0.10;
    for (let i = 0; i < next.length; i++) {
      const b = next[i];
      const dx = b.tx - b.x;
      const dy = b.ty - b.y;
      b.vx += dx * springK * step;
      b.vy += dy * springK * step;
      b.vx += (Math.random() - 0.5) * b.wiggle * wiggleScale * step;
      b.vy += (Math.random() - 0.5) * b.wiggle * wiggleScale * step;
      b.vx *= damping;
      b.vy *= damping;
      b.x += b.vx * step;
      b.y += b.vy * step;
    }

    // Pairwise collision resolution
    const restitution = 0.55;
    for (let i = 0; i < next.length; i++) {
      const a = next[i];
      for (let j = i + 1; j < next.length; j++) {
        const b = next[j];
        const ddx = b.x - a.x;
        const ddy = b.y - a.y;
        const minDist = a.r + b.r;
        const distSq = ddx * ddx + ddy * ddy;
        if (distSq >= minDist * minDist || distSq === 0) continue;
        const dist = Math.sqrt(distSq);
        const nx = ddx / dist;
        const ny = ddy / dist;
        const overlap = minDist - dist;
        const half = overlap * 0.5;
        a.x -= nx * half;
        a.y -= ny * half;
        b.x += nx * half;
        b.y += ny * half;
        const relVx = b.vx - a.vx;
        const relVy = b.vy - a.vy;
        const relV_n = relVx * nx + relVy * ny;
        if (relV_n >= 0) continue;
        const impulse = relV_n * restitution;
        a.vx += impulse * nx;
        a.vy += impulse * ny;
        b.vx -= impulse * nx;
        b.vy -= impulse * ny;
      }
    }

    physics.value = next;
  });

  return (
    <>
      <Canvas
        style={{
          position: "absolute",
          left: -canvasLeftOffset,
          top: 0,
          width: starFieldWidth,
          height: canvasHeight,
        }}
      >
        {/* Stars fill the entire canvas, including the 20% margin
            that lives beyond the universe boundary. The margins are
            only visible when the user reaches the elastic edge —
            then they peek past the universe and see more cosmos. */}
        <StarField width={starFieldWidth} height={canvasHeight} tickMs={tickMs} />
        {bubbles.map((b, i) => {
          const cluster = clusters.find((c) => c.id === b.clusterId)!;
          return (
            <BubbleNode
              key={b.id}
              bubble={b}
              cluster={cluster}
              index={i}
              physics={physics}
              tickMs={tickMs}
              drawOffsetX={bubbleDrawOffsetX}
            />
          );
        })}
      </Canvas>
      {bubbles.map((b, i) => {
        const cluster = clusters.find((c) => c.id === b.clusterId)!;
        const label = b.label || shortLabel(b.title ?? "");
        if (!label) return null;
        if (b.kind === "cluster") {
          return (
            <BubbleLabel
              key={`label-${b.id}`}
              index={i}
              physics={physics}
              label={cluster.name}
              subtitle={
                b.taskCount !== undefined
                  ? `${b.taskCount} task${b.taskCount === 1 ? "" : "s"}`
                  : undefined
              }
              size="dominant"
            />
          );
        }
        const showAsDominant = b.isDominant && cluster.kind !== "drift";
        return (
          <BubbleLabel
            key={`label-${b.id}`}
            index={i}
            physics={physics}
            label={showAsDominant ? cluster.name : label}
            subtitle={showAsDominant ? label : undefined}
            size={showAsDominant ? "dominant" : "normal"}
          />
        );
      })}
      {bubbles.map((b, i) => (
        <BubbleHitArea
          key={`hit-${b.id}`}
          index={i}
          physics={physics}
          onPress={() => onBubblePress(b)}
          onLongPress={onBubbleLongPress ? () => onBubbleLongPress(b) : undefined}
        />
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas, position: "relative" },
  backOverlay: {
    position: "absolute",
    top: 10,
    left: 12,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    paddingLeft: 4,
    paddingRight: 8,
    backgroundColor: "rgba(17, 20, 42, 0.7)",
    borderRadius: 18,
    borderColor: colors.line,
    borderWidth: 1,
    maxWidth: "75%",
    gap: 2,
  },
  backOverlayBack: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: 8,
    gap: 2,
  },
  backOverlayText: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: "600",
  },
  backOverlayPencil: {
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderLeftColor: colors.line,
    borderLeftWidth: 1,
    marginLeft: 2,
  },
  emptyClusterHint: {
    position: "absolute",
    top: "40%",
    left: 40,
    right: 40,
    alignItems: "center",
  },
  emptyClusterTitle: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
  },
  emptyClusterBody: {
    color: colors.inkDim,
    fontSize: 12,
    marginTop: 8,
    textAlign: "center",
    lineHeight: 17,
  },
  // Re-center pill — small, top-center, only visible while panned.
  // Picks up the same panel-on-canvas treatment as the back overlay
  // so it feels like part of the same UI layer.
  recenterBtn: {
    position: "absolute",
    top: 10,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: "rgba(17, 20, 42, 0.85)",
    borderRadius: 16,
    borderColor: colors.line,
    borderWidth: 1,
  },
  recenterText: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: "600",
  },
  // Pushes the re-center pill below whichever overlay is already at
  // top: 10 (back-to-clusters chevron when drilled, or the search
  // result pill when search is active).
  recenterBtnShifted: { top: 50 },
  // Search-result pill — top-center, same chrome family as the back
  // overlay so it reads as part of the same UI layer. Drops below the
  // back overlay when drilled (rare combo but possible if the user
  // drills into a cluster while a search is also active).
  searchPill: {
    position: "absolute",
    top: 10,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 6,
    paddingLeft: 12,
    paddingRight: 6,
    backgroundColor: "rgba(17, 20, 42, 0.85)",
    borderRadius: 16,
    borderColor: colors.line,
    borderWidth: 1,
    maxWidth: "82%",
  },
  searchPillDrilled: { top: 56 },
  searchPillText: { color: colors.ink, fontSize: 12, fontWeight: "600" },
  searchPillClear: {
    paddingHorizontal: 4,
    paddingVertical: 2,
    marginLeft: 4,
    borderLeftColor: colors.line,
    borderLeftWidth: 1,
  },
});

interface BubbleProps {
  bubble: Bubble;
  cluster: Cluster;
  index: number;
  physics: SharedValue<PhysicsState[]>;
  tickMs: SharedValue<number>;
  // Constant X offset added to the Skia draw position. Used when the
  // Canvas is wider than the screen and shifted left so that the
  // universe extends past both edges — the bubble physics still
  // computes positions in screen coords; we add the Canvas's left
  // shift when drawing so they line up with their RN-side label.
  drawOffsetX?: number;
}

const BubbleNode: React.FC<BubbleProps> = ({
  bubble,
  cluster,
  index,
  physics,
  tickMs,
  drawOffsetX = 0,
}) => {
  // Cluster bubbles carry an explicit radius set by the layout pass
  // (sqrt of task count). Task bubbles fall back to pressure-based
  // sizing plus the overdue chunkiness boost. Without this, every
  // cluster bubble would draw at 16px because pressureScore is 0 for
  // them, while their physics hitbox is correct (30–72px).
  const baseRadius = radiusFor(bubble);
  // Color resolution order: overdue (red pulse) > bubble.color override
  // (used in search view so each match keeps its origin cluster color)
  // > the bubble's current cluster color.
  const baseColor = bubble.overdue
    ? colors.overdue
    : bubble.color ?? cluster.color;

  // Position. cx adds drawOffsetX so the screen-coord physics value
  // lands at the right place inside the wider-than-screen Canvas.
  const cx = useDerivedValue(() => (physics.value[index]?.x ?? 0) + drawOffsetX);
  const cy = useDerivedValue(() => physics.value[index]?.y ?? 0);

  // Overdue bubbles breathe: radius and opacity oscillate.
  const radius = useDerivedValue(() => {
    if (!bubble.overdue) return baseRadius;
    const phase = (tickMs.value / 1000) * Math.PI; // ~2s period
    return baseRadius + Math.sin(phase) * 2;
  });
  const opacity = useDerivedValue(() => {
    if (!bubble.overdue) return 0.9;
    const phase = (tickMs.value / 1000) * Math.PI;
    return 0.85 + Math.sin(phase) * 0.12;
  });

  // Outline radius slightly larger than the fill — Skia doesn't have a
  // "stroke on the outside" mode, so we draw a second circle with the
  // outline color/width and the fill on top.
  const outlineRadius = useDerivedValue(() => radius.value + 1);

  return (
    <Group>
      {/* Soft outline ring */}
      <Circle
        cx={cx}
        cy={cy}
        r={outlineRadius}
        color="white"
        opacity={0.35}
      />
      {/* Bubble fill */}
      <Circle cx={cx} cy={cy} r={radius} color={baseColor} opacity={opacity} />
    </Group>
  );
};
