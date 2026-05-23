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

import React, { useEffect, useMemo, useRef } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import {
  Canvas,
  Circle,
  Group,
} from "@shopify/react-native-skia";
import {
  useSharedValue,
  useDerivedValue,
  useFrameCallback,
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
      r: pressureToRadius(b.pressureScore) + (b.overdue ? OVERDUE_RADIUS_BOOST : 0),
      // Brownian amplitude. Slightly wider than the first calm pass —
      // bubbles felt tethered too tightly before. Still gentle, the
      // step coefficient in the worklet (wiggleScale) keeps per-frame
      // motion small so the wider amplitude reads as drift, not jitter.
      wiggle: 0.14 + (b.pressureScore / 10) * 0.3,
    };
  });
}

interface BubbleCanvasProps {
  // Called when the user taps a bubble. Receives the underlying task id
  // (which is also the bubble id — they're one-to-one). Optional so the
  // canvas remains usable in read-only contexts.
  onBubbleTap?: (taskId: string) => void;
}

export default function BubbleCanvas({ onBubbleTap }: BubbleCanvasProps = {}) {
  const { width, height } = useWindowDimensions();
  // Approximate canvas height — leaves room for the header strip + tab bar.
  // Actual layout will be tightened once those components ship.
  const canvasHeight = Math.max(360, height - 180);

  const clusters = useUniverseStore((s) => s.clusters);
  const bubbles = useUniverseStore((s) => s.bubbles);

  const initial = useMemo(
    () => buildInitialStates(bubbles, clusters, width, canvasHeight),
    [bubbles, clusters, width, canvasHeight],
  );

  const physics = useSharedValue<PhysicsState[]>(initial);
  // Tracks which bubble IDs were in each physics slot the last time we
  // synced. Lets the resync below preserve in-flight positions for
  // bubbles that already exist while still adding entries for new ones.
  const lastSyncedIds = useRef<string[]>(bubbles.map((b) => b.id));

  // Resync the shared array whenever the bubbles set changes (new task
  // added, bubble removed, cluster moved). Without this, useSharedValue
  // sticks with whatever was passed on first render and new bubbles end
  // up reading physics.value[index] === undefined → (0, 0) → top-left
  // corner.
  useEffect(() => {
    const prev = physics.value;
    const prevIds = lastSyncedIds.current;
    const next = initial.map((init, i) => {
      const id = bubbles[i].id;
      const prevIdx = prevIds.indexOf(id);
      if (prevIdx >= 0 && prev[prevIdx]) {
        // Keep the running x/y/vx/vy from the live physics slot, but
        // pick up any layout updates (target, radius, wiggle amplitude)
        // from the freshly-built initial state.
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

  // Monotonic UI-thread clock used by the overdue pulse effect.
  const tickMs = useSharedValue<number>(0);

  useFrameCallback((info) => {
    "worklet";
    const dt = info.timeSincePreviousFrame ?? 16;
    if (!dt) return;
    tickMs.value += dt;

    // Normalize dt to ~1 unit at 60fps so spring constants below behave
    // the same on phones with different refresh rates.
    const step = Math.min(dt / 16, 2);

    const next = physics.value.slice();

    // ---- Pass 1: spring + wiggle + damping + integrate ---------------
    // Spring tug toward each bubble's orbital target. Weakened
    // further so bubbles have more room to roam — combined with the
    // higher wiggle amplitude, the visual feel is "drifting in a
    // gentle current" rather than "tethered to a peg".
    const springK = 0.0016;       // was 0.0022
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

    // ---- Pass 2: pairwise collision resolution ----------------------
    // For each overlapping pair, push them apart along the contact
    // normal and exchange normal-velocity components (equal-mass
    // elastic collision) with a mild damping factor so the bounce
    // feels soft rather than rubbery. O(n^2) is fine at 50ish bubbles.
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
        // Separate so they're no longer overlapping. Move each by half
        // the overlap; mass-equal split keeps the system symmetric.
        const overlap = minDist - dist;
        const half = overlap * 0.5;
        a.x -= nx * half;
        a.y -= ny * half;
        b.x += nx * half;
        b.y += ny * half;
        // Bounce only if they're moving toward each other (positive
        // relative velocity along the normal would mean separating;
        // skipping that prevents sticky re-bounces).
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
    <View style={styles.root}>
      <Canvas style={StyleSheet.absoluteFill}>
        {/* Star field renders behind the bubbles — same canvas, drawn
            first so the bubbles z-order over it. */}
        <StarField width={width} height={canvasHeight} tickMs={tickMs} />
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
            />
          );
        })}
      </Canvas>
      {/* Labels and touch overlays drift with the bubbles via the same
          shared physics value. Rendered as siblings (not children) of
          Canvas because Skia nodes can't host RN views. */}
      {bubbles.map((b, i) => {
        const cluster = clusters.find((c) => c.id === b.clusterId)!;
        // Bubble carries a server-stored label (with a client-side
        // fallback for legacy rows) — no further shortening needed.
        const label = b.label || shortLabel(b.title ?? "");
        if (!label) return null;
        // Dominant cluster-name overlay only makes sense for real
        // clusters (Work / Health / etc). Drift is a synthetic
        // catch-all for tasks with no parent — labelling its
        // dominant with "DRIFT" just confuses the user about what
        // the bubble represents.
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
      {onBubbleTap
        ? bubbles.map((b, i) => (
            <BubbleHitArea
              key={`hit-${b.id}`}
              index={i}
              physics={physics}
              onPress={() => onBubbleTap(b.id)}
            />
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas, position: "relative" },
});

interface BubbleProps {
  bubble: Bubble;
  cluster: Cluster;
  index: number;
  physics: SharedValue<PhysicsState[]>;
  tickMs: SharedValue<number>;
}

const BubbleNode: React.FC<BubbleProps> = ({
  bubble,
  cluster,
  index,
  physics,
  tickMs,
}) => {
  const baseRadius =
    pressureToRadius(bubble.pressureScore) + (bubble.overdue ? OVERDUE_RADIUS_BOOST : 0);
  const baseColor = bubble.overdue ? colors.overdue : cluster.color;

  // Position
  const cx = useDerivedValue(() => physics.value[index]?.x ?? 0);
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
