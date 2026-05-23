// Zustand store for the bubble universe.
//
// Hydrates from /api/v1/tasks + /api/v1/clusters once at mount, runs the
// pair through services/universeLayout.ts, and exposes the canvas-shaped
// state to BubbleCanvas. No seed data — a brand-new user just sees an
// empty universe with the EmptyState component until they create a task.

import { create } from "zustand";

import type { Bubble, Cluster } from "@/components/universe/types";
import { listClusters, listTasks, type ServerTask } from "@/services/api";
import { layoutUniverse } from "@/services/universeLayout";

export type UniverseStatus = "idle" | "loading" | "ready" | "error";

interface UniverseState {
  status: UniverseStatus;
  errorMessage: string | null;
  clusters: Cluster[];
  bubbles: Bubble[];
  // Holds the raw server tasks so addTask() can recompute layout without
  // a second network round-trip when a new task is created.
  serverTasks: ServerTask[];
  hydrate: () => Promise<void>;
  addTask: (task: ServerTask) => void;
}

export const useUniverseStore = create<UniverseState>((set, get) => ({
  status: "idle",
  errorMessage: null,
  clusters: [],
  bubbles: [],
  serverTasks: [],

  hydrate: async () => {
    set({ status: "loading", errorMessage: null });
    try {
      const [tasks, clusters] = await Promise.all([listTasks(), listClusters()]);
      const layout = layoutUniverse(clusters, tasks);
      set({
        status: "ready",
        errorMessage: null,
        clusters: layout.clusters,
        bubbles: layout.bubbles,
        serverTasks: tasks,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({
        status: "error",
        errorMessage: msg,
        clusters: [],
        bubbles: [],
        serverTasks: [],
      });
    }
  },

  addTask: (task) => {
    // Recompute layout with the new task prepended. The full layout pass
    // is cheap (a few sorts over a small array) and guarantees the canvas
    // matches what a fresh hydrate() would produce.
    const { serverTasks, clusters } = get();
    const nextTasks = [task, ...serverTasks];
    // Re-fetching clusters isn't necessary because creating a task
    // never adds a cluster — but we still need the server cluster
    // shapes for the layout pass. Reconstruct ServerCluster-shaped
    // input from the canvas Cluster list. The synthetic Drift cluster
    // is skipped because layoutUniverse will re-add it if needed.
    const serverClusterShape = clusters
      .filter((c) => c.id !== "synthetic-drift")
      .map((c) => ({
        id: c.id,
        owner_id: "",
        name: c.name,
        summary: null,
        color: c.color,
        weight_score: 0,
        active_count: 0,
        parent_cluster_id: null,
        created_at: "",
      }));
    const layout = layoutUniverse(serverClusterShape, nextTasks);
    set({
      serverTasks: nextTasks,
      clusters: layout.clusters,
      bubbles: layout.bubbles,
    });
  },
}));
