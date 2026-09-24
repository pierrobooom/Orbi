// Bubble universe canvas — state 1 from orbi_mobile_sketch.html.
//
// Each bubble has a shared physics state. A useFrameCallback worklet runs
// on the UI thread every frame and applies:
//   1. orbit      — the anchor point itself traces a slow, bounded loop
//   2. spring     — pull toward that moving anchor
//   3. damping    — prevents runaway oscillation
//   4. collisions — pairwise separation so bubbles never overlap
//
// Motion used to be Brownian: a per-frame random impulse fighting a stiff
// spring under 0.95 damping. Random walk cancels itself out, so the net
// result was bubbles that visibly twitched but never went anywhere — the
// universe read as static.
//
// Now each bubble orbits its anchor on a Lissajous path: two sine waves at
// slightly different very-low frequencies, with a random phase and period
// per bubble. That gives motion which is
//   - smooth (a continuous curve, not a jitter),
//   - slow (14-26 second periods),
//   - non-repeating to the eye (x and y periods never divide evenly), and
//   - permanently bounded — the anchor is fixed and the orbit radius is
//     small, so a bubble can drift from its home but can never wander off.
// The spring follows the moving target with a slight lag, which is what
// makes the drift feel like it has weight rather than being a rigid path.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import {
  Gesture,
  GestureDetector,
  type GestureType,
} from "react-native-gesture-handler";
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

import { useT } from "@/i18n";
import { useReduceMotion } from "@/hooks/useReduceMotion";
import { colors } from "@/theme/colors";
import { BREATHE_MS, BREATHE_SCALE, PULSE_MS } from "@/theme/motion";
import { useUniverseStore } from "@/stores/universeStore";
import BubbleHitArea from "./BubbleHitArea";
import BubbleLabel from "./BubbleLabel";
import StarField from "./StarField";
import type { Cluster, Bubble, PhysicsState } from "./types";

function pressureToRadius(p: number): number {
  "worklet";
  // 26px at rest, 40px at pressure 10.
  //
  // Up from 16–24, which was a deliberate choice for a screen full of tasks
  // and the wrong one for the screen people actually see. A cluster drilled
  // into usually holds a handful of things, and at 16px they read as specks
  // in a lot of empty space — nothing like the 30–72px cluster bubbles the
  // user just came from. The crowding scale below is what earns this back
  // when a cluster really does fill up.
  return 26 + (Math.max(0, Math.min(10, p)) / 10) * 14;
}

// How far the drop shadow sits below its bubble. A constant transform, so
// it costs nothing per frame.
const SHADOW_SHIFT = [{ translateY: 3 }];

// Whether the star field is drawn behind the bubbles. Off while the ground
// is paper — the stars are white and would be invisible. Flips back on with
// night mode; see the note at the render site.
const SHOW_STARS = false;

// Bubbles stay full size up to this many, then shrink.
//
// Chosen as "a cluster you can take in at a glance". Below it there is space
// going spare and no reason to make anything smaller.
const FULL_SIZE_UP_TO = 8;

// Never shrink past this, however many there are. Past roughly half size a
// bubble stops carrying a readable label and becomes a dot, at which point
// the view has stopped being a universe and become a scatter plot.
const MIN_CROWDING_SCALE = 0.45;

function crowdingScale(taskCount: number): number {
  "worklet";
  if (taskCount <= FULL_SIZE_UP_TO) return 1;
  // Inverse square root, so the TOTAL area of the bubbles stays roughly
  // constant as they multiply — which is what makes it read as the camera
  // pulling back rather than as everything arbitrarily deflating.
  return Math.max(
    MIN_CROWDING_SCALE,
    Math.sqrt(FULL_SIZE_UP_TO / taskCount),
  );
}

// Overdue bubbles get a flat size boost on top of pressure-based sizing
// so they read as physically chunkier, not just animated. The breathing
// pulse on top of this still works.
//
// Applied BEFORE the crowding scale, so an overdue bubble in a crowded
// cluster stays proportionally bigger than its neighbours rather than
// having its one distinguishing feature scaled away.
const OVERDUE_RADIUS_BOOST = 6;

// Bubbles are small (task radius ~15–43px depending on pressure, overdue
// and how many share the view); long titles overflow as a single glyph run
// because Skia text doesn't wrap. We extract a short label
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

// How many characters a task bubble's label can hold at a given crowding.
//
// 14 was fixed, which was right for exactly one bubble size. Now that a quiet
// cluster draws at 33px and a full one at 15, a fixed budget either overflows
// the small ones or wastes the large ones.
function labelBudget(crowding: number): number {
  return Math.max(8, Math.round(18 * crowding));
}

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
function radiusFor(b: Bubble, crowding: number = 1): number {
  // Cluster bubbles carry an explicit radius from the layout pass and are
  // never crowded — there are only ever a handful of them.
  if (b.radius !== undefined) return b.radius;
  const base =
    pressureToRadius(b.pressureScore) + (b.overdue ? OVERDUE_RADIUS_BOOST : 0);
  return base * crowding;
}

function buildInitialStates(
  bubbles: Bubble[],
  clusters: Cluster[],
  width: number,
  height: number,
  crowding: number = 1,
): PhysicsState[] {
  return bubbles.map((b) => {
    const cluster = clusters.find((c) => c.id === b.clusterId)!;
    const cx = cluster.centerX * width;
    const cy = cluster.centerY * height;
    // A placement the user made wins over the computed layout. Stored as a
    // fraction of the canvas, so it lands in the same relative spot on any
    // screen rather than at whatever pixel it happened to be dropped on.
    const placed = b.placedX != null && b.placedY != null;
    const tx = placed ? b.placedX! * width : cx + b.offsetX;
    const ty = placed ? b.placedY! * height : cy + b.offsetY;
    return {
      x: tx,
      y: ty,
      vx: 0,
      vy: 0,
      tx,
      ty,
      // r is the collision radius — include the overdue boost so the
      // physics hitbox matches what the user sees.
      r: radiusFor(b, crowding),
      // A whisper of Brownian on top of the orbit — just enough that
      // two bubbles sharing a similar path don't look mechanically
      // synchronised. An order of magnitude below the old value.
      wiggle: b.kind === "cluster" ? 0.012 : 0.018,
      // Cluster bubbles are big and carry the top-level layout, so they
      // drift less in absolute terms than the task bubbles inside them.
      orbitR: b.kind === "cluster" ? 9 : 13,
      // Random phase so nothing starts in step.
      phaseX: Math.random() * Math.PI * 2,
      phaseY: Math.random() * Math.PI * 2,
      // Periods of roughly 14-26s, with x and y deliberately unequal so
      // the path is a slow open curve rather than a circle or a line.
      freqX: (Math.PI * 2) / (14000 + Math.random() * 12000),
      freqY: (Math.PI * 2) / (16000 + Math.random() * 12000),
      id: b.id,
      dragging: 0,
      placed: placed ? 1 : 0,
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
  // Where the user dropped a bubble, as a 0..1 fraction of the canvas. The
  // canvas does not save it — it has no business knowing about the API —
  // it just reports what happened and lets the screen persist it.
  onBubbleMoved?: (
    kind: "cluster" | "task",
    id: string,
    x: number,
    y: number,
  ) => void;
}

export default function BubbleCanvas({
  onBubbleTap,
  onClusterLongPress,
  onTaskLongPress,
  onEditFocusedCluster,
  onBubbleMoved,
}: BubbleCanvasProps = {}) {
  const t = useT();
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
         // So a bubble drag can suppress the canvas pan for its duration.
         canvasPan={pan}
         onBubbleMoved={
           onBubbleMoved
             ? (bubble, x, y) =>
                 onBubbleMoved(
                   bubble.kind === "cluster" ? "cluster" : "task",
                   bubble.id,
                   x,
                   y,
                 )
             : undefined
         }
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
          <Text style={styles.recenterText}>{t("Re-center")}</Text>
        </Pressable>
      ) : null}
      {/* Back overlay — only visible in drilled view. Lives OUTSIDE
          the animated wrapper so it remains tappable through any
          residual transform; it triggers its own animated exit. */}
      {/* Drilled view with no tasks — render a centered hint so the
          screen isn't blank apart from the back overlay. */}
      {focusedCluster && bubbles.length === 0 ? (
        <View pointerEvents="none" style={styles.emptyClusterHint}>
          <Text style={styles.emptyClusterTitle}>{t("No tasks here yet")}</Text>
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
  // Where a bubble was dropped, normalised to the canvas.
  onBubbleMoved?: (bubble: Bubble, x: number, y: number) => void;
  // Passed straight to each hit area so a bubble drag can block it.
  canvasPan?: GestureType;
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
  onBubbleMoved,
  canvasPan,
}: BubbleFieldProps) {
  // Read once for the whole field and handed to every bubble, rather than
  // subscribed to fifty times over. Switches off breathing and the overdue
  // halo; nothing is lost, because overdue is red and carries a red dot
  // whether or not it moves.
  const reduceMotion = useReduceMotion();
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
  // How much to shrink task bubbles because of how many there are. Computed
  // once here and passed to BOTH the physics and the drawing: they each call
  // radiusFor, and a factor applied to one but not the other would give every
  // bubble a hitbox that no longer matches the circle people can see.
  const taskCount = bubbles.filter((b) => b.radius === undefined).length;
  const crowding = crowdingScale(taskCount);

  const initial = useMemo(
    () => buildInitialStates(bubbles, clusters, width, canvasHeight, crowding),
    [bubbles, clusters, width, canvasHeight, crowding],
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
        // Keep the live position AND the existing orbit, so a bubble
        // that survives a resync doesn't jump to a new phase — it just
        // continues its path around the (possibly moved) anchor.
        return {
          x: prev[prevIdx].x,
          y: prev[prevIdx].y,
          vx: prev[prevIdx].vx,
          vy: prev[prevIdx].vy,
          tx: init.tx,
          ty: init.ty,
          r: init.r,
          wiggle: init.wiggle,
          orbitR: prev[prevIdx].orbitR,
          phaseX: prev[prevIdx].phaseX,
          phaseY: prev[prevIdx].phaseY,
          freqX: prev[prevIdx].freqX,
          freqY: prev[prevIdx].freqY,
          id,
          // A resync while a finger is down would otherwise drop the
          // bubble mid-drag.
          dragging: prev[prevIdx].dragging,
          placed: 0,
          // A bubble the user has placed keeps where they put it: the
          // anchor was moved on drop, and a resync must not send it
          // home again.
          ...(prev[prevIdx].placed
            ? { tx: prev[prevIdx].tx, ty: prev[prevIdx].ty, placed: 1 }
            : {}),
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

    // Orbit + spring + damping + integrate.
    //
    // springK is up from 0.0016: the target now moves, and too soft a
    // spring lags so far behind that the orbit never shows. Damping is
    // down from 0.95 to let the bubble actually travel — at 0.95 the
    // velocity was bled off almost as fast as the spring added it.
    const springK = 0.0042;
    const damping = 0.90;
    const wiggleScale = 0.10;
    const now = tickMs.value;
    for (let i = 0; i < next.length; i++) {
      const b = next[i];
      // Held bubbles are not simulated. Letting the spring run while a
      // finger drags produces a bubble that lags behind the touch and
      // snaps forward on release — the exact "cheap" feel this is meant
      // to avoid.
      if (b.dragging) {
        b.vx = 0;
        b.vy = 0;
        continue;
      }
      // The anchor traces the orbit; the bubble springs toward it.
      const ax = b.tx + Math.sin(now * b.freqX + b.phaseX) * b.orbitR;
      const ay = b.ty + Math.cos(now * b.freqY + b.phaseY) * b.orbitR;
      const dx = ax - b.x;
      const dy = ay - b.y;
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
        // A held bubble is immovable: the other one takes the whole
        // separation. Splitting it evenly would slide the bubble out from
        // under the finger every time it touched a neighbour.
        const aFixed = a.dragging === 1;
        const bFixed = b.dragging === 1;
        const aShare = aFixed ? 0 : bFixed ? overlap : overlap * 0.5;
        const bShare = bFixed ? 0 : aFixed ? overlap : overlap * 0.5;
        a.x -= nx * aShare;
        a.y -= ny * aShare;
        b.x += nx * bShare;
        b.y += ny * bShare;
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
        {/* No stars on a daylight ground.
            The field is white and pale lilac points, which were the whole
            atmosphere against #07080F and are simply invisible on paper —
            75 circles of cost for nothing anyone can see. The component is
            kept, not deleted: it is exactly right again the moment night
            mode lands, and it renders here once the ground is dark.
            See theme/colors.ts for why that is its own piece of work. */}
        {SHOW_STARS ? (
          <StarField width={starFieldWidth} height={canvasHeight} tickMs={tickMs} />
        ) : null}
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
              crowding={crowding}
              still={reduceMotion}
            />
          );
        })}
      </Canvas>
      {bubbles.map((b, i) => {
        const cluster = clusters.find((c) => c.id === b.clusterId)!;
        // Bigger bubbles can carry more of the title, and crowded ones
        // less. Tying the budget to the radius means the text shrinks with
        // the circle instead of overflowing it the moment a cluster fills up.
        const label =
          b.label || shortLabel(b.title ?? "", labelBudget(crowding));
        if (!label) return null;
        if (b.kind === "cluster") {
          return (
            <BubbleLabel
              key={`label-${b.id}`}
              index={i}
              bubbleId={b.id}
              fallback={initial[i]}
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
            bubbleId={b.id}
            fallback={initial[i]}
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
          bubbleId={b.id}
          fallback={initial[i]}
          physics={physics}
          canvasPan={canvasPan}
          canvasWidth={width}
          canvasHeight={canvasHeight}
          onMoved={
            onBubbleMoved ? (x, y) => onBubbleMoved(b, x, y) : undefined
          }
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
    backgroundColor: "rgba(255, 255, 255, 0.92)",
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
    backgroundColor: "rgba(255, 255, 255, 0.94)",
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
    backgroundColor: "rgba(255, 255, 255, 0.94)",
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
  // Whether the system has asked for reduced motion. Passed in rather than
  // read here: this renders once per bubble, and 50 subscriptions to the
  // same accessibility flag is 49 too many.
  still?: boolean;
  // The same factor the physics used. Not recomputed here — two derivations
  // of one number drift, and this one decides both what is drawn and what
  // can be tapped.
  crowding?: number;
}

const BubbleNode: React.FC<BubbleProps> = ({
  bubble,
  cluster,
  index,
  physics,
  tickMs,
  drawOffsetX = 0,
  crowding = 1,
  still = false,
}) => {
  // Cluster bubbles carry an explicit radius set by the layout pass
  // (sqrt of task count). Task bubbles fall back to pressure-based
  // sizing plus the overdue chunkiness boost. Without this, every
  // cluster bubble would draw at 16px because pressureScore is 0 for
  // them, while their physics hitbox is correct (30–72px).
  const baseRadius = radiusFor(bubble, crowding);
  // Color resolution order: overdue (red pulse) > bubble.color override
  // (used in search view so each match keeps its origin cluster color)
  // > the bubble's current cluster color.
  // A shared task wears a ring. Colour was the other option and is already
  // spoken for — it says which cluster a bubble belongs to, and overriding
  // that would trade one piece of information for another rather than
  // adding any.
  const shared = Boolean(bubble.shared);
  const baseColor = bubble.overdue
    ? colors.overdue
    : bubble.color ?? cluster.color;

  // Position. cx adds drawOffsetX so the screen-coord physics value
  // lands at the right place inside the wider-than-screen Canvas.
  const cx = useDerivedValue(() => (physics.value[index]?.x ?? 0) + drawOffsetX);
  const cy = useDerivedValue(() => physics.value[index]?.y ?? 0);

  // Every bubble breathes, not just the overdue ones.
  //
  // Two per cent over seven seconds. The point is that the universe looks
  // alive, not that anything appears to be happening — at five per cent the
  // eye starts tracking it and the screen becomes restless. The phase is
  // offset per bubble so the field never pulses in unison, which reads as a
  // rendering fault rather than as breath.
  const radius = useDerivedValue(() => {
    if (still) return baseRadius;
    const phase =
      (tickMs.value / BREATHE_MS) * Math.PI * 2 + index * 0.7;
    return baseRadius * (1 + Math.sin(phase) * BREATHE_SCALE);
  });

  // Solid. The old 0.9 was letting a dark ground show through to soften the
  // fill; on paper it only makes the colour look uncertain, and these
  // colours are the one place the app is allowed to be confident.
  const opacity = 1;

  // The overdue halo: a ring outside the bubble, fading in and out.
  //
  // Replaces oscillating the bubble's own radius and opacity, which made
  // overdue tasks both wobble and dim — dimming the one thing that most
  // needs attention. The halo pulses; the bubble underneath stays solid.
  //
  // The early return is a PERFORMANCE guard, not a tidiness one. Reanimated
  // works out a derived value's dependencies by watching which shared
  // values the worklet actually reads, so a body that returns before
  // touching tickMs never subscribes to it and never re-runs. Reading it
  // unconditionally put every bubble on the frame clock for a ring that is
  // not drawn, which is what turned the universe choppy.
  const pulses = Boolean(bubble.overdue) && !still;
  const haloRadius = useDerivedValue(() => {
    if (!pulses) return baseRadius + 7;
    const phase = (tickMs.value / PULSE_MS) * Math.PI * 2;
    return baseRadius + 7 + Math.sin(phase) * 3;
  });
  const haloOpacity = useDerivedValue(() => {
    if (!pulses) return 0.28;
    const phase = (tickMs.value / PULSE_MS) * Math.PI * 2;
    return 0.3 + Math.sin(phase) * 0.18;
  });
  // Sits outside the bubble with a gap, so it reads as a ring around the
  // task rather than as a thicker edge on it — a thicker edge would just
  // look like a rendering difference.
  const sharedRingRadius = useDerivedValue(() => radius.value + 4);

  return (
    <Group>
      {/* Overdue halo, outermost so it reads as light coming off the
          bubble rather than as a border on it. */}
      {bubble.overdue ? (
        <Circle
          cx={cx}
          cy={cy}
          r={haloRadius}
          color={colors.overdue}
          opacity={haloOpacity}
        />
      ) : null}
      {/* Shared-task ring. Inside the halo, outside the bubble. */}
      {shared ? (
        <Circle
          cx={cx}
          cy={cy}
          r={sharedRingRadius}
          color={colors.accent}
          opacity={0.55}
          style="stroke"
          strokeWidth={2}
        />
      ) : null}
      {/* Drop shadow: the same circle, three pixels down, barely there.
          Offset with a static Group transform rather than a derived cy —
          the offset is constant, and a derived value would have put a
          second per-frame subscription on every bubble to add 3. */}
      <Group transform={SHADOW_SHIFT}>
        <Circle cx={cx} cy={cy} r={radius} color="#1B1D26" opacity={0.16} />
      </Group>
      {/* Bubble fill */}
      <Circle cx={cx} cy={cy} r={radius} color={baseColor} opacity={opacity} />
    </Group>
  );
};
