// Zustand store for the bubble universe.
//
// Currently seeded with hardcoded data that mirrors state 1 of the sketch
// (orbi_mobile_sketch.html). Once the /tasks endpoint is wired up the
// hydration step will fetch from the backend and replace the seed values.

import { create } from "zustand";

import { colors } from "@/theme/colors";
import type { Cluster, SeedBubble } from "@/components/universe/types";

const WORK = "cluster-work";
const HEALTH = "cluster-health";
const PERSONAL = "cluster-personal";
const FINANCE = "cluster-finance";
const DRIFT = "cluster-drift";

const seedClusters: Cluster[] = [
  { id: WORK,     name: "Work",     kind: "work",     color: colors.work,     centerX: 0.25, centerY: 0.22 },
  { id: HEALTH,   name: "Health",   kind: "health",   color: colors.health,   centerX: 0.72, centerY: 0.20 },
  { id: PERSONAL, name: "Personal", kind: "personal", color: colors.personal, centerX: 0.28, centerY: 0.66 },
  { id: FINANCE,  name: "Finance",  kind: "finance",  color: colors.finance,  centerX: 0.68, centerY: 0.70 },
  // Drift is the catch-all for uncategorized bubbles. Neutral gray,
  // visually quiet, no orbit outline. Center is between the four real
  // clusters so unsorted items sit in the middle of the universe.
  { id: DRIFT,    name: "Drift",    kind: "drift",    color: colors.drift,    centerX: 0.50, centerY: 0.46 },
];

const seedBubbles: SeedBubble[] = [
  // ── Work
  { id: "b-q2",      title: "Q2 plan · Tue",  clusterId: WORK,     pressureScore: 7.5, isDominant: true, offsetX:   0, offsetY:   0 },
  { id: "b-emails",  title: "Emails",         clusterId: WORK,     pressureScore: 4.0,                   offsetX:  36, offsetY:  22 },
  { id: "b-1on1",    title: "1:1 prep",       clusterId: WORK,     pressureScore: 2.0,                   offsetX:  16, offsetY:  40 },

  // ── Health
  { id: "b-gym",     title: "Gym · 6pm",      clusterId: HEALTH,   pressureScore: 5.5, isDominant: true, offsetX:   0, offsetY:   0 },
  { id: "b-meds",    title: "Meds",           clusterId: HEALTH,   pressureScore: 3.0,                   offsetX: -22, offsetY:  26 },
  { id: "b-dentist", title: "Dentist",        clusterId: HEALTH,   pressureScore: 1.5,                   offsetX:  20, offsetY:  32 },

  // ── Personal
  { id: "b-bday",    title: "Mum's b-day",    clusterId: PERSONAL, pressureScore: 5.0, isDominant: true, offsetX:   0, offsetY:   0 },
  { id: "b-call",    title: "Call Sarah",     clusterId: PERSONAL, pressureScore: 2.5,                   offsetX: -28, offsetY:  24 },
  { id: "b-coffee",  title: "Coffee w/ Tom",  clusterId: PERSONAL, pressureScore: 3.5,                   offsetX:  20, offsetY:  26 },

  // ── Finance (Rent is overdue — dominant, pulses red)
  { id: "b-rent",    title: "Rent · overdue", clusterId: FINANCE,  pressureScore: 9.4, overdue: true, isDominant: true, offsetX: 0, offsetY: 0 },
  { id: "b-council", title: "Council tax",    clusterId: FINANCE,  pressureScore: 4.0,                   offsetX:  40, offsetY:  22 },
  { id: "b-netflix", title: "Netflix",        clusterId: FINANCE,  pressureScore: 1.5,                   offsetX:  28, offsetY: -22 },

  // ── Drift (uncategorized; no labels, neutral gray)
  { id: "b-drift1",  title: "",               clusterId: DRIFT,    pressureScore: 2.0,                   offsetX:   0, offsetY:   0 },
  { id: "b-drift2",  title: "",               clusterId: DRIFT,    pressureScore: 1.4,                   offsetX:  18, offsetY:  14 },
];

interface UniverseState {
  clusters: Cluster[];
  bubbles: SeedBubble[];
}

export const useUniverseStore = create<UniverseState>(() => ({
  clusters: seedClusters,
  bubbles: seedBubbles,
}));
