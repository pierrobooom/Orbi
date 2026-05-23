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

// Stop / weak-verb sets used by the shortLabel fallback so the
// derivation matches the server-side derive_label_from_title.
const _LABEL_STOP_WORDS = new Set([
  "a", "an", "the", "to", "from", "about", "of", "for", "with",
  "and", "or", "in", "on", "at", "by", "as", "is", "was", "are",
  "be", "been", "this", "that", "these", "those", "my", "your",
  "i", "im", "i'm", "ive", "i've",
]);
const _LABEL_LOW_SIGNAL_VERBS = new Set([
  "call", "buy", "go", "send", "email", "remind", "make", "do",
  "get", "have", "take", "pick", "drop", "visit", "see", "check",
  "need", "want", "should", "must", "gotta", "going", "gonna",
]);

/** Server-style shortLabel fallback. Only invoked when a task has no
 * stored label (pre-0005 rows). New tasks get their label from the
 * server which uses the equivalent Python derive_label_from_title. */
function deriveLabel(title: string, maxChars = 14): string {
  const trimmed = (title ?? "").trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxChars) return trimmed;
  const words = trimmed.split(/\s+/);
  const content = words.filter((w) => {
    const lower = w.toLowerCase().replace(/[^a-z0-9']/g, "");
    if (!lower) return false;
    if (_LABEL_STOP_WORDS.has(lower)) return false;
    if (_LABEL_LOW_SIGNAL_VERBS.has(lower)) return false;
    return true;
  });
  const pickFrom = content.length > 0 ? content : words;
  let out = "";
  for (const w of pickFrom) {
    const candidate = out ? `${out} ${w}` : w;
    if (candidate.length > maxChars) break;
    out = candidate;
  }
  if (!out) out = trimmed.slice(0, maxChars);
  return out;
}

// Golden-angle spiral so non-dominant bubbles spread naturally without
// piling up at any one angle. The dominant sits at (0, 0); index 1+
// orbit out from there.
const GOLDEN_ANGLE = 137.5 * (Math.PI / 180);

function offsetForRank(rank: number, baseDistance = 60, stepDistance = 12): { x: number; y: number } {
  if (rank === 0) return { x: 0, y: 0 };
  // Generous distance so even the tightest pair clears the dominant
  // bubble's radius (~10–36px) with breathing room. Each successive
  // rank adds another step outward.
  const angle = rank * GOLDEN_ANGLE;
  const distance = baseDistance + (rank - 1) * stepDistance;
  return { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance };
}

// Cluster bubble radius scales by sqrt of task count so a cluster with
// 25 tasks looks ~5x bigger than one with a single task — visible
// hierarchy without dwarfing small clusters. Clamped to a sane range
// so 1-task clusters are still readable and 100-task clusters don't
// eat the canvas.
const CLUSTER_BUBBLE_MIN_R = 30;
const CLUSTER_BUBBLE_MAX_R = 72;
function clusterRadius(taskCount: number): number {
  const r = CLUSTER_BUBBLE_MIN_R + Math.sqrt(Math.max(1, taskCount)) * 9;
  return Math.min(CLUSTER_BUBBLE_MAX_R, Math.max(CLUSTER_BUBBLE_MIN_R, r));
}

export interface LayoutResult {
  clusters: Cluster[];
  bubbles: Bubble[];
}

export function layoutUniverse(
  serverClusters: ServerCluster[],
  serverTasks: ServerTask[],
  now: Date = new Date(),
  // When set, the layout produces "drilled" view — only this cluster's
  // task bubbles, spread across the full canvas. When null/undefined,
  // it produces "cluster" view — one bubble per cluster, sized by task
  // count.
  activeClusterId: string | null = null,
): LayoutResult {
  // Build canvas clusters from server clusters.
  const canvasClusters: Cluster[] = serverClusters.map((c) => {
    const kind = classifyKind(c.name);
    const pos = KIND_POSITIONS[kind];
    return {
      id: c.id,
      name: c.name,
      kind,
      // Use the color the user picked in the cluster editor when set;
      // fall back to the canonical kind color only when the server
      // returned no color (legacy rows). Previously we always used
      // KIND_COLORS which silently ignored the user's choice.
      color: (c.color && c.color.trim().length > 0) ? c.color : KIND_COLORS[kind],
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

  // -------------------------------------------------------------------
  // Drilled view — one cluster's tasks, spread across the full canvas
  // -------------------------------------------------------------------
  // When `activeClusterId` matches a known cluster, we surface ONLY
  // that cluster's task bubbles, repositioned around the canvas center
  // with a wider orbit so they don't pile up. The other clusters are
  // hidden — the back overlay handles navigation.
  if (activeClusterId && knownClusterIds.has(activeClusterId)) {
    const focused = canvasClusters.find((c) => c.id === activeClusterId)!;
    const tasks = (tasksByCluster.get(activeClusterId) ?? [])
      .slice()
      .sort((a, b) => b.pressure_score - a.pressure_score);

    // Force the cluster center to canvas-middle in drilled view so
    // the bubbles use the whole screen, not their canonical corner.
    const drilledCluster: Cluster = {
      ...focused,
      centerX: 0.5,
      centerY: 0.46,
    };

    const bubbles: Bubble[] = tasks.map((t, rank) => {
      // Wider orbital spread than the clustered view — more screen
      // real estate to play with when only one cluster is shown.
      const offset = offsetForRank(rank, 110, 22);
      const label = t.label && t.label.trim().length > 0
        ? t.label.trim()
        : deriveLabel(t.title);
      return {
        id: t.id,
        title: t.title,
        label,
        clusterId: drilledCluster.id,
        pressureScore: t.pressure_score,
        overdue: isOverdue(t, now),
        // No dominant in drilled view — the cluster name is in the
        // header overlay, every task bubble shows its own label only.
        isDominant: false,
        offsetX: offset.x,
        offsetY: offset.y,
        kind: "task",
      };
    });

    return { clusters: [drilledCluster], bubbles };
  }

  // -------------------------------------------------------------------
  // Top-level cluster view — one bubble per cluster
  // -------------------------------------------------------------------
  const bubbles: Bubble[] = canvasClusters.map((cluster) => {
    const tasks = tasksByCluster.get(cluster.id) ?? [];
    const count = tasks.length;
    // A cluster reads as "overdue" if any of its tasks are — surfaces
    // urgency without needing to drill in. Drift is excluded so the
    // catch-all bucket doesn't pulse just because it caught one
    // overdue task.
    const hasOverdue =
      cluster.kind !== "drift" && tasks.some((t) => isOverdue(t, now));
    return {
      // Use the cluster's id as the bubble id so taps map directly to
      // enterCluster without a lookup.
      id: cluster.id,
      // Title is the cluster name; falls through to label for any
      // place that reads from `title`.
      title: cluster.name,
      label: cluster.name,
      clusterId: cluster.id,
      pressureScore: 0, // unused for cluster bubbles
      overdue: hasOverdue,
      isDominant: false,
      offsetX: 0,
      offsetY: 0,
      kind: "cluster",
      radius: clusterRadius(count),
      taskCount: count,
    };
  });

  return { clusters: canvasClusters, bubbles };
}
