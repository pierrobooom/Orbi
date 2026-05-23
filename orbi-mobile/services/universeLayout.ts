// Bridge between the backend's Cluster + Task wire shapes and the
// canvas's Cluster + Bubble shapes. Pure — no React, no Zustand, no
// network. Easy to test in isolation and easy to swap out later if the
// backend ever grows a `kind` column or layout coordinates of its own.
//
// What this function does:
//   1. Maps each server cluster's name → a known ClusterKind (work,
//      health, finance, personal, home, learning) or falls back to drift.
//   2. Places each cluster at the canonical canvas position for its
//      kind. Multiple clusters with the same kind overlap for now.
//   3. Synthesizes a single Drift cluster on demand for tasks whose
//      parent_cluster_id is null (uncategorized).
//   4. Per cluster: sorts tasks by pressure_score desc. The top task
//      becomes the dominant bubble (carries the cluster name as label);
//      the rest get a golden-angle spiral offset around the dominant.
//   5. Computes `overdue` per task: due_at < now AND status === active.

import type { Bubble, Cluster, ClusterKind } from "@/components/universe/types";
import { colors } from "@/theme/colors";
import type { ServerCluster, ServerTask } from "@/services/api";

// ID for the synthetic catch-all cluster. Doesn't exist on the backend.
const DRIFT_ID = "synthetic-drift";

const KIND_POSITIONS: Record<ClusterKind, { x: number; y: number }> = {
  work: { x: 0.25, y: 0.22 },
  health: { x: 0.72, y: 0.2 },
  personal: { x: 0.28, y: 0.66 },
  finance: { x: 0.68, y: 0.7 },
  home: { x: 0.18, y: 0.45 },
  learning: { x: 0.78, y: 0.45 },
  drift: { x: 0.5, y: 0.46 },
};

const KIND_COLORS: Record<ClusterKind, string> = {
  work: colors.work,
  health: colors.health,
  personal: colors.personal,
  finance: colors.finance,
  home: colors.home,
  learning: colors.learning,
  drift: colors.drift,
};

// Substring match on the lowercased cluster name. First hit wins.
const KIND_KEYWORDS: ReadonlyArray<[ClusterKind, ReadonlyArray<string>]> = [
  ["work", ["work", "job", "office", "career"]],
  ["health", ["health", "fitness", "wellness", "gym", "medical"]],
  ["finance", ["finance", "money", "bills", "budget", "expense"]],
  ["personal", ["personal", "family", "social", "friends"]],
  ["home", ["home", "house", "chores", "garden"]],
  ["learning", ["learning", "study", "reading", "course"]],
];

function classifyKind(name: string): ClusterKind {
  const n = name.toLowerCase();
  for (const [kind, keywords] of KIND_KEYWORDS) {
    if (keywords.some((k) => n.includes(k))) return kind;
  }
  return "drift";
}

function isOverdue(task: ServerTask, now: Date): boolean {
  if (task.status !== "active") return false;
  if (!task.due_at) return false;
  return new Date(task.due_at) < now;
}

// Golden-angle spiral so non-dominant bubbles spread naturally without
// piling up at any one angle. The dominant sits at (0, 0); index 1+
// orbit out from there.
const GOLDEN_ANGLE = 137.5 * (Math.PI / 180);

function offsetForRank(rank: number): { x: number; y: number } {
  if (rank === 0) return { x: 0, y: 0 };
  // Generous distance so even the tightest pair clears the dominant
  // bubble's radius (~10–36px) with breathing room. Each successive
  // rank adds another step outward.
  const angle = rank * GOLDEN_ANGLE;
  const distance = 60 + (rank - 1) * 12;
  return { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance };
}

export interface LayoutResult {
  clusters: Cluster[];
  bubbles: Bubble[];
}

export function layoutUniverse(
  serverClusters: ServerCluster[],
  serverTasks: ServerTask[],
  now: Date = new Date(),
): LayoutResult {
  // Build canvas clusters from server clusters.
  const canvasClusters: Cluster[] = serverClusters.map((c) => {
    const kind = classifyKind(c.name);
    const pos = KIND_POSITIONS[kind];
    return {
      id: c.id,
      name: c.name,
      kind,
      // Use the kind's canonical color so the canvas stays consistent
      // even if a user picks a clashing color in the backend.
      color: KIND_COLORS[kind],
      centerX: pos.x,
      centerY: pos.y,
    };
  });

  // Decide whether to add the synthetic Drift cluster.
  const hasUncategorized = serverTasks.some(
    (t) => t.parent_cluster_id == null && t.status === "active",
  );
  const driftAlreadyPresent = canvasClusters.some((c) => c.kind === "drift");
  if (hasUncategorized && !driftAlreadyPresent) {
    canvasClusters.push({
      id: DRIFT_ID,
      name: "Drift",
      kind: "drift",
      color: KIND_COLORS.drift,
      centerX: KIND_POSITIONS.drift.x,
      centerY: KIND_POSITIONS.drift.y,
    });
  }

  // Resolve a target cluster id for each active task. Tasks pointing at
  // a cluster we don't know about (deleted?) fall into Drift too.
  const knownClusterIds = new Set(canvasClusters.map((c) => c.id));
  const tasksByCluster = new Map<string, ServerTask[]>();
  for (const t of serverTasks) {
    if (t.status !== "active") continue;
    const targetId =
      t.parent_cluster_id && knownClusterIds.has(t.parent_cluster_id)
        ? t.parent_cluster_id
        : DRIFT_ID;
    if (!tasksByCluster.has(targetId)) tasksByCluster.set(targetId, []);
    tasksByCluster.get(targetId)!.push(t);
  }

  // Convert into canvas Bubbles, sorting each cluster by pressure desc
  // and assigning isDominant + offset by rank.
  const bubbles: Bubble[] = [];
  for (const cluster of canvasClusters) {
    const tasks = tasksByCluster.get(cluster.id) ?? [];
    tasks.sort((a, b) => b.pressure_score - a.pressure_score);
    tasks.forEach((t, rank) => {
      const offset = offsetForRank(rank);
      bubbles.push({
        id: t.id,
        title: t.title,
        clusterId: cluster.id,
        pressureScore: t.pressure_score,
        overdue: isOverdue(t, now),
        isDominant: rank === 0,
        offsetX: offset.x,
        offsetY: offset.y,
      });
    });
  }

  return { clusters: canvasClusters, bubbles };
}
