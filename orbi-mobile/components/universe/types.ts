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

export interface SeedBubble {
  id: string;
  title: string;
  clusterId: string;
  // 0..10. Drives radius and Brownian wiggle amplitude.
  pressureScore: number;
  // When true the bubble pulses red and overrides the cluster color.
  overdue?: boolean;
  // The single largest bubble per cluster — carries the cluster name as
  // its primary label per the sketch's resolved design.
  isDominant?: boolean;
  // Starting offset (pixels) from the cluster center. Physics takes
  // over after the first frame.
  offsetX: number;
  offsetY: number;
}
