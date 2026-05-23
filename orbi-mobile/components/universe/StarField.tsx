// Background star field for the bubble universe.
//
// Renders ~70 small static-position stars across the canvas, each with
// its own opacity oscillation phase so the field twinkles softly. The
// positions are seeded once (per canvas mount) and don't move — only
// the opacity animates on the UI thread via useDerivedValue.
//
// Implementation note: Reanimated's hook rules forbid calling
// useDerivedValue inside a loop, so each star is its own component.

import { Circle } from "@shopify/react-native-skia";
import React, { useMemo } from "react";
import { useDerivedValue, type SharedValue } from "react-native-reanimated";

const STAR_COUNT = 70;
// Stars cluster slightly toward the upper portion to look more
// authentically "night sky" — the bubbles dominate the lower half of
// the canvas anyway, so dense stars there fight the foreground.
const TOP_BIAS = 0.6;

interface Seed {
  x: number;
  y: number;
  radius: number;
  baseOpacity: number;
  phase: number; // seconds offset
  // 1 = brighter star (rarer), 0 = standard dim star.
  bright: number;
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
      phase: rand() * Math.PI * 2,
      bright,
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
  return (
    <>
      {seeds.map((seed, i) => (
        <Star key={i} seed={seed} tickMs={tickMs} />
      ))}
    </>
  );
}

interface StarProps {
  seed: Seed;
  tickMs: SharedValue<number>;
}

function Star({ seed, tickMs }: StarProps) {
  // Twinkle: opacity oscillates around baseOpacity with a small
  // amplitude and a per-star phase, so neighbouring stars don't pulse
  // in unison. Slow period (~4–6s) for a calm sky.
  const opacity = useDerivedValue(() => {
    const t = (tickMs.value / 1000) + seed.phase;
    const wave = Math.sin(t * 0.6);
    const amp = seed.bright === 1 ? 0.18 : 0.1;
    return Math.max(0.05, seed.baseOpacity + wave * amp);
  });
  return (
    <Circle
      cx={seed.x}
      cy={seed.y}
      r={seed.radius}
      color={seed.bright === 1 ? "#dcd6ff" : "white"}
      opacity={opacity}
    />
  );
}
