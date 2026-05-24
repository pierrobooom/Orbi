// Shapes used by the bubble universe canvas. These mirror the backend
// TaskBubble + Cluster models but stay deliberately minimal until the
// API is wired up — fields that exist server-side but the canvas doesn't
// need (embedding, descriptions, dependency counts) are intentionally
// omitted.

export type ClusterKind =
  | "work"
  | "health"
  | "finance"
  | "personal"
  | "home"
  | "learning"
  | "drift";

export interface Cluster {
  id: string;
  name: string;
  kind: ClusterKind;
  color: string;
  // Center expressed as a fraction of the canvas (0..1) so the layout
  // adapts to any screen size without hardcoded pixel coords.
  centerX: number;
  centerY: number;
}

export interface Bubble {
  id: string;
  title: string;
  // Short keyword shown inside the bubble. Falls back to a derived
  // version of the title when the server task has no label set.
  label: string;
  clusterId: string;
  // 0..10. Drives radius and Brownian wiggle amplitude when kind is
  // "task". Ignored for cluster bubbles (their radius comes from
  // taskCount via the explicit `radius` field below).
  pressureScore: number;
  // When true the bubble pulses red and overrides the cluster color.
  overdue?: boolean;
  // The single largest bubble per cluster — carries the cluster name as
  // its primary label per the sketch's resolved design. Used in
  // drilled (task) view only; cluster bubbles never have it.
  isDominant?: boolean;
  // Starting offset (pixels) from the cluster center. Physics takes
  // over after the first frame.
  offsetX: number;
  offsetY: number;
  // Discriminator. "cluster" = top-level cluster-as-bubble view; "task"
  // = drilled view where each individual task is a bubble. Defaults to
  // "task" so legacy code paths keep working until the canvas is
  // upgraded to read this.
  kind?: "cluster" | "task";
  // Explicit radius override. Set by the layout pass for cluster
  // bubbles (sqrt of task count), where pressureScore is meaningless.
  // When undefined, the canvas falls back to its pressure-based calc.
  radius?: number;
  // Number of active tasks in this cluster — only set on cluster
  // bubbles, used to size the bubble and decorate the label.
  taskCount?: number;
  // Explicit color override. Used in search view so each matched
  // bubble keeps its ORIGINAL cluster color even though it's
  // positioned inside the synthetic search-results cluster — the user
  // can tell at a glance which cluster each match came from.
  color?: string;
}
