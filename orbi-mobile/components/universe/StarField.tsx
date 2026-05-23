// Background star field for the bubble universe.
//
// Renders ~75 small static-position stars across the canvas, each
// belonging to one of PHASE_BUCKETS twinkle groups. The earlier
// version used one useDerivedValue PER STAR (75 worklets/frame for
// the twinkle), which dropped frames during pan + decay. The bucket
// approach uses ONE derived value per group, so the per-frame cost
// is O(buckets) instead of O(stars). Each star inside a group renders
// with its own static baseOpacity; the group's animated opacity
// multiplies through for the collective twinkle. Buckets are phase-
// offset so the sky doesn't pulse in unison.
//
// Implementation note: Reanimated's hook rules forbid calling
// useDerivedValue inside a loop, so each bucket is its own component.

import { Circle, Group } from "@shopify/react-native-skia";
import React, { useMemo } from "react";
import { useDerivedValue, type SharedValue } from "react-native-reanimated";

const STAR_COUNT = 75;
// Stars cluster slightly toward the upper portion to look more
// authentically "night sky" — the bubbles dominate the lower half of
// the canvas anyway, so dense stars there fight the foreground.
const TOP_BIAS = 0.6;

// Number of independent twinkle groups. Each group runs a single
// worklet per frame regardless of how many stars it owns. 6 is enough
// to avoid the field looking like it's pulsing in unison; bumping
// higher buys little visual variety at noticeable cost.
const PHASE_BUCKETS = 6;

interface Seed {
  x: number;
  y: number;
  radius: number;
  baseOpacity: number;
  // 1 = brighter star (rarer), 0 = standard dim star.
  bright: number;
  // Which phase bucket this star belongs to (0..PHASE_BUCKETS-1).
  bucket: number;
}

interface Props {
  width: number;
  height: number;
  tickMs: SharedValue<number>;
}

function generateSeeds(width: number, height: number, salt: number): Seed[] {
  // Simple deterministic PRNG so re-renders don't shuffle the field.
  let s = salt + 1;
  const rand = (): number => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  const seeds: Seed[] = [];
  for (let i = 0; i < STAR_COUNT; i++) {
    const yBias = rand() < TOP_BIAS ? rand() * 0.55 : 0.55 + rand() * 0.45;
    const bright = rand() < 0.12 ? 1 : 0;
    seeds.push({
      x: rand() * width,
      y: yBias * height,
      radius: bright === 1 ? 1.5 + rand() * 0.8 : 0.5 + rand() * 0.6,
      baseOpacity: bright === 1 ? 0.55 + rand() * 0.25 : 0.18 + rand() * 0.22,
      bright,
      // Round-robin bucket assignment via the PRNG so the buckets
      // are spread across positions, not clumped.
      bucket: Math.floor(rand() * PHASE_BUCKETS),
    });
  }
  return seeds;
}

export default function StarField({ width, height, tickMs }: Props) {
  // Seed once per canvas size — when the device rotates or the canvas
  // resizes, we regenerate. The salt keeps subsequent renders stable.
  const seeds = useMemo(
    () => generateSeeds(width, height, Math.floor(width + height)),
    [width, height],
  );

  // Pre-bucket so the render pass doesn't filter every frame.
  const buckets = useMemo(() => {
    const out: Seed[][] = Array.from({ length: PHASE_BUCKETS }, () => []);
    for (const seed of seeds) {
      out[seed.bucket].push(seed);
    }
    return out;
  }, [seeds]);

  return (
    <>
      {buckets.map((bucketSeeds, i) =>
        bucketSeeds.length > 0 ? (
          <StarBucket key={i} index={i} seeds={bucketSeeds} tickMs={tickMs} />
        ) : null,
      )}
    </>
  );
}

interface BucketProps {
  index: number;
  seeds: Seed[];
  tickMs: SharedValue<number>;
}

function StarBucket({ index, seeds, tickMs }: BucketProps) {
  // One worklet per bucket. Wave amplitude is gentle (0.78–1.0) so
  // stars never fully wash out, and per-bucket phase offset keeps
  // adjacent buckets out of sync so the field doesn't breathe as one.
  const groupOpacity = useDerivedValue(() => {
    const t = tickMs.value / 1000 + index * 0.83;
    const wave = Math.sin(t * 0.55);
    return 0.78 + wave * 0.11; // ~0.67 to ~0.89
  });

  return (
    <Group opacity={groupOpacity}>
      {seeds.map((seed, i) => (
        <Circle
          key={i}
          cx={seed.x}
          cy={seed.y}
          r={seed.radius}
          color={seed.bright === 1 ? "#dcd6ff" : "white"}
          // Per-star opacity stays static — Group opacity multiplies
          // through, so each star still has its own brightness while
          // the twinkle animation runs at O(buckets) per frame.
          opacity={seed.baseOpacity}
        />
      ))}
    </Group>
  );
}
