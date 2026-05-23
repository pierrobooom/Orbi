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
import { useWindowDimensions } from "react-native";
import {
  Canvas,
  Circle,
  Group,
  Text as SkText,
  matchFont,
  type SkFont,
} from "@shopify/react-native-skia";
import {
  useSharedValue,
  useDerivedValue,
  useFrameCallback,
  type SharedValue,
} from "react-native-reanimated";

import { colors } from "@/theme/colors";
import { useUniverseStore } from "@/stores/universeStore";
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
  return 10 + (Math.max(0, Math.min(10, p)) / 10) * 26;
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
      r: pressureToRadius(b.pressureScore),
      wiggle: 0.25 + (b.pressureScore / 10) * 0.9,
    };
  });
}

export default function BubbleCanvas() {
  const { width, height } = useWindowDimensions();
  // Approximate canvas height — leaves room for the header strip + tab bar.
  // Actual layout will be tightened once those components ship.
  const canvasHeight = Math.max(360, height - 180);

  const clusters = useUniverseStore((s) => s.clusters);
  const bubbles = useUniverseStore((s) => s.bubbles);

  const labelFont: SkFont = matchFont({ fontFamily: "", fontSize: 11, fontStyle: "normal", fontWeight: "600" } as never);
  const dimLabelFont: SkFont = matchFont({ fontFamily: "", fontSize: 9, fontStyle: "normal", fontWeight: "400" } as never);
  const dominantFont: SkFont = matchFont({ fontFamily: "", fontSize: 13, fontStyle: "normal", fontWeight: "700" } as never);

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
    for (let i = 0; i < next.length; i++) {
      const b = next[i];
      // 1. Spring toward this bubble's own target (not the cluster
      // center) so each bubble settles at its own orbital spot.
      const dx = b.tx - b.x;
      const dy = b.ty - b.y;
      const springK = 0.004;
      b.vx += dx * springK * step;
      b.vy += dy * springK * step;
      // 2. Brownian wiggle (scaled by pressure)
      b.vx += (Math.random() - 0.5) * b.wiggle * 0.18 * step;
      b.vy += (Math.random() - 0.5) * b.wiggle * 0.18 * step;
      // 3. Damping — without this the spring would oscillate forever
      b.vx *= 0.93;
      b.vy *= 0.93;
      // Integrate
      b.x += b.vx * step;
      b.y += b.vy * step;
    }
    physics.value = next;
  });

  return (
    <Canvas style={{ flex: 1, backgroundColor: colors.canvas }}>
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
            font={labelFont}
            dimFont={dimLabelFont}
            dominantFont={dominantFont}
          />
        );
      })}
    </Canvas>
  );
}

interface BubbleProps {
  bubble: Bubble;
  cluster: Cluster;
  index: number;
  physics: SharedValue<PhysicsState[]>;
  tickMs: SharedValue<number>;
  font: SkFont;
  dimFont: SkFont;
  dominantFont: SkFont;
}

const BubbleNode: React.FC<BubbleProps> = ({
  bubble,
  cluster,
  index,
  physics,
  tickMs,
  font,
  dimFont,
  dominantFont,
}) => {
  const baseRadius = pressureToRadius(bubble.pressureScore);
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

  // Text needs to be centered manually — Skia <Text> uses the x value as
  // the left edge of the glyph run, not the anchor. Measure once and offset.
  const dominantTextWidth = useMemo(
    () => (bubble.isDominant ? dominantFont.measureText(cluster.name).width : 0),
    [bubble.isDominant, dominantFont, cluster.name],
  );
  const titleWidth = useMemo(
    () => (bubble.title ? font.measureText(bubble.title).width : 0),
    [bubble.title, font],
  );
  const dimTitleWidth = useMemo(
    () => (bubble.title ? dimFont.measureText(bubble.title).width : 0),
    [bubble.title, dimFont],
  );

  const dominantNameX = useDerivedValue(
    () => (physics.value[index]?.x ?? 0) - dominantTextWidth / 2,
  );
  const dominantNameY = useDerivedValue(
    () => (physics.value[index]?.y ?? 0) - 2,
  );
  const dominantSubX = useDerivedValue(
    () => (physics.value[index]?.x ?? 0) - dimTitleWidth / 2,
  );
  const dominantSubY = useDerivedValue(
    () => (physics.value[index]?.y ?? 0) + 12,
  );
  const titleX = useDerivedValue(
    () => (physics.value[index]?.x ?? 0) - titleWidth / 2,
  );
  const titleY = useDerivedValue(
    () => (physics.value[index]?.y ?? 0) + 3,
  );

  return (
    <Group>
      <Circle cx={cx} cy={cy} r={radius} color={baseColor} opacity={opacity} />

      {bubble.isDominant ? (
        <>
          <SkText x={dominantNameX} y={dominantNameY} text={cluster.name} font={dominantFont} color="white" />
          <SkText x={dominantSubX} y={dominantSubY} text={bubble.title} font={dimFont} color="white" opacity={0.85} />
        </>
      ) : bubble.title && cluster.kind !== "drift" ? (
        <SkText x={titleX} y={titleY} text={bubble.title} font={font} color="white" />
      ) : null}
    </Group>
  );
};
