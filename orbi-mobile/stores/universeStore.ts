// Zustand store for the bubble universe.
//
// Hydrates from /api/v1/tasks + /api/v1/clusters once at mount, runs the
// pair through services/universeLayout.ts, and exposes the canvas-shaped
// state to BubbleCanvas. No seed data — a brand-new user just sees an
// empty universe with the EmptyState component until they create a task.

import { create } from "zustand";

import type { Bubble, Cluster } from "@/components/universe/types";
import {
  listClusters,
  listTasks,
  type ServerCluster,
  type ServerTask,
} from "@/services/api";
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
  // Also kept so the cluster-only top view and the drilled task view
  // can both be rebuilt without re-fetching. Layout is recomputed any
  // time activeClusterId changes.
  serverClusters: ServerCluster[];
  // null = top-level cluster view; a cluster id = drilled view showing
  // only that cluster's tasks.
  activeClusterId: string | null;
  hydrate: () => Promise<void>;
  addTask: (task: ServerTask) => void;
  replaceTask: (task: ServerTask) => void;
  removeTask: (taskId: string) => void;
  getServerTask: (taskId: string) => ServerTask | undefined;
  enterCluster: (clusterId: string) => void;
  exitCluster: () => void;
}

export const useUniverseStore = create<UniverseState>((set, get) => ({
  status: "idle",
  errorMessage: null,
  clusters: [],
  bubbles: [],
  serverTasks: [],
  serverClusters: [],
  activeClusterId: null,

  hydrate: async () => {
    set({ status: "loading", errorMessage: null });
    try {
      const [tasks, clusters] = await Promise.all([listTasks(), listClusters()]);
      const { activeClusterId } = get();
      const layout = layoutUniverse(clusters, tasks, new Date(), activeClusterId);
      set({
        status: "ready",
        errorMessage: null,
        clusters: layout.clusters,
        bubbles: layout.bubbles,
        serverTasks: tasks,
        serverClusters: clusters,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({
        status: "error",
        errorMessage: msg,
        clusters: [],
        bubbles: [],
        serverTasks: [],
        serverClusters: [],
      });
    }
  },

  addTask: (task) => {
    // Recompute layout with the new task prepended. The full layout pass
    // is cheap (a few sorts over a small array) and guarantees the canvas
    // matches what a fresh hydrate() would produce.
    const { serverTasks, serverClusters, activeClusterId } = get();
    const nextTasks = [task, ...serverTasks];
    const layout = layoutUniverse(serverClusters, nextTasks, new Date(), activeClusterId);
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
    const { serverTasks, serverClusters, activeClusterId } = get();
    const nextTasks = serverTasks.map((t) => (t.id === task.id ? task : t));
    const layout = layoutUniverse(serverClusters, nextTasks, new Date(), activeClusterId);
    set({
      serverTasks: nextTasks,
      clusters: layout.clusters,
      bubbles: layout.bubbles,
    });
  },

  removeTask: (taskId) => {
    const { serverTasks, serverClusters, activeClusterId } = get();
    const nextTasks = serverTasks.filter((t) => t.id !== taskId);
    const layout = layoutUniverse(serverClusters, nextTasks, new Date(), activeClusterId);
    set({
      serverTasks: nextTasks,
      clusters: layout.clusters,
      bubbles: layout.bubbles,
    });
  },

  getServerTask: (taskId) => get().serverTasks.find((t) => t.id === taskId),

  enterCluster: (clusterId) => {
    // Switching to drilled view — rebuild layout with the active id so
    // the canvas sees the task bubbles for just that cluster.
    const { serverTasks, serverClusters } = get();
    const layout = layoutUniverse(serverClusters, serverTasks, new Date(), clusterId);
    set({
      activeClusterId: clusterId,
      clusters: layout.clusters,
      bubbles: layout.bubbles,
    });
  },

  exitCluster: () => {
    const { serverTasks, serverClusters } = get();
    const layout = layoutUniverse(serverClusters, serverTasks, new Date(), null);
    set({
      activeClusterId: null,
      clusters: layout.clusters,
      bubbles: layout.bubbles,
    });
  },
}));
