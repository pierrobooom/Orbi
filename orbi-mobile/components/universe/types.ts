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

/** One bubble's live simulation state, shared between the canvas that draws
 * it, the label that follows it, and the touch overlay that moves it.
 *
 * Declared here rather than copied into each file. It used to be duplicated
 * three times with a comment in each saying the shape "has to match exactly
 * or the SharedValue types stop being assignable" — which is true, and is
 * exactly why it should not have been written out three times. Adding one
 * field broke two files that had no reason to care about it.
 */
export interface PhysicsState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  // The per-bubble target the spring pulls toward. Each non-dominant bubble
  // settles at its own orbital spot around the cluster centre; without this
  // they would all spring to the shared centre and overlap.
  tx: number;
  ty: number;
  r: number;
  wiggle: number;
  // Orbit around (tx, ty). Fixed per bubble for its lifetime, so the path is
  // stable across frames and the bubble always has a home to return to.
  orbitR: number;
  phaseX: number;
  phaseY: number;
  freqX: number;
  freqY: number;
  // Consumers resolve by id rather than array position, so a one-render-stale
  // array cannot hand them another bubble's coordinates.
  id: string;
  // 1 while a finger is holding this bubble: the frame loop skips orbit,
  // spring and damping for it, and collisions treat it as immovable.
  dragging: number;
  // 1 once the user has dropped it somewhere deliberately, so a resync does
  // not quietly send it home again.
  placed: number;
}
