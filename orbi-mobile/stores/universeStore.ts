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
  // Holds the raw server tasks so addTask() / replaceTask() / removeTask()
  // can recompute layout without a second network round-trip.
  serverTasks: ServerTask[];
  hydrate: () => Promise<void>;
  addTask: (task: ServerTask) => void;
  replaceTask: (task: ServerTask) => void;
  removeTask: (taskId: string) => void;
  getServerTask: (taskId: string) => ServerTask | undefined;
}

// Server-cluster reconstruction used by every mutating action. We keep
// the cluster shapes around in canvas form only; rebuilding the wire
// shape for the layout pass is cheap and avoids re-fetching.
function clustersToServerShape(canvas: Cluster[]): Array<{
  id: string;
  owner_id: string;
  name: string;
  summary: string | null;
  color: string;
  weight_score: number;
  active_count: number;
  parent_cluster_id: string | null;
  created_at: string;
}> {
  return canvas
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
    const layout = layoutUniverse(clustersToServerShape(clusters), nextTasks);
    set({
      serverTasks: nextTasks,
      clusters: layout.clusters,
      bubbles: layout.bubbles,
    });
  },

  replaceTask: (task) => {
    // Swap the existing record (by id) with an updated copy. If the new
    // status is no longer 'active', layoutUniverse will naturally drop
    // it from the bubble list since it only renders active tasks.
    const { serverTasks, clusters } = get();
    const nextTasks = serverTasks.map((t) => (t.id === task.id ? task : t));
    const layout = layoutUniverse(clustersToServerShape(clusters), nextTasks);
    set({
      serverTasks: nextTasks,
      clusters: layout.clusters,
      bubbles: layout.bubbles,
    });
  },

  removeTask: (taskId) => {
    const { serverTasks, clusters } = get();
    const nextTasks = serverTasks.filter((t) => t.id !== taskId);
    const layout = layoutUniverse(clustersToServerShape(clusters), nextTasks);
    set({
      serverTasks: nextTasks,
      clusters: layout.clusters,
      bubbles: layout.bubbles,
    });
  },

  getServerTask: (taskId) => get().serverTasks.find((t) => t.id === taskId),
}));
