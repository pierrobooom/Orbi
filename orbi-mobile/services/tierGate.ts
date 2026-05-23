// Pure tier-gating helpers. Centralises the rules so the Universe screen,
// upgrade modal, and any future tier-locked surface all reason the same way.
//
// Server-side enforcement (usage_tracker.py) is the source of truth for AI /
// STT / TTS caps. These helpers are the client-side mirror — they make the
// UI feel responsive (disable buttons before a doomed request) and consistent
// with the marketing names users see.

import type { SubscriptionTier } from "@/stores/authStore";
import type { UsageSnapshot } from "@/services/api";

// CLAUDE.md per-tier object caps. Server-side enforcement is a TODO so the
// client is the only thing standing between a determined Spark user and an
// unbounded universe. Hard-block at exactly these numbers.
const BUBBLE_CAPS: Record<SubscriptionTier, number | null> = {
  free: 50,
  pro: 500,
  premium: null, // unlimited
};

export const TIER_DISPLAY: Record<SubscriptionTier, string> = {
  free: "Spark",
  pro: "Pro",
  premium: "Genius",
};

export interface GateAllow {
  allowed: true;
}

export interface GateDeny {
  allowed: false;
  reason: string;
  // Short copy suitable for an inline error chip or toast.
  hint: string;
}

export type GateResult = GateAllow | GateDeny;

export function canCreateBubble(args: {
  tier: SubscriptionTier;
  bubbleCount: number;
}): GateResult {
  const cap = BUBBLE_CAPS[args.tier];
  if (cap === null) return { allowed: true };
  if (args.bubbleCount < cap) return { allowed: true };
  return {
    allowed: false,
    reason: `Spark tier caps the universe at ${cap} bubbles.`,
    hint: `${TIER_DISPLAY[args.tier]} cap reached — upgrade for more bubbles.`,
  };
}

// Formatters --------------------------------------------------------------

/** "12 / 30 turns" — null when the meter is fully disabled for this tier. */
export function formatTurnsChip(usage: UsageSnapshot | null): string | null {
  if (!usage) return null;
  const meter = usage.daily.ai_turn;
  if (!meter || meter.cap <= 0) return null;
  return `${meter.used} / ${meter.cap} turns`;
}

/** True when the user is within one call of their daily AI cap. */
export function isNearAiCap(usage: UsageSnapshot | null): boolean {
  if (!usage) return false;
  const meter = usage.daily.ai_turn;
  if (!meter || meter.cap <= 0) return false;
  return meter.used >= meter.cap - 1;
}

/** True when the daily AI cap is already exhausted. */
export function isAtAiCap(usage: UsageSnapshot | null): boolean {
  if (!usage) return false;
  const meter = usage.daily.ai_turn;
  if (!meter || meter.cap <= 0) return false;
  return meter.used >= meter.cap;
}
