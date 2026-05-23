// Holds the user's quota snapshot. Refreshed on Universe mount and after
// each voice/chat call so the inline "12 / 30 turns" chip stays close to
// reality without polling.

import { create } from "zustand";

import { getMyUsage, type UsageSnapshot } from "@/services/api";

export type UsageStatus = "idle" | "loading" | "ready" | "error";

interface UsageState {
  status: UsageStatus;
  errorMessage: string | null;
  usage: UsageSnapshot | null;
  hydrate: () => Promise<void>;
}

export const useUsageStore = create<UsageState>((set, get) => ({
  status: "idle",
  errorMessage: null,
  usage: null,
  hydrate: async () => {
    // Don't show a fresh spinner on every refresh — keep the previous
    // snapshot visible while we refetch so the chip doesn't flicker.
    if (get().status === "idle") set({ status: "loading" });
    try {
      const usage = await getMyUsage();
      set({ status: "ready", usage, errorMessage: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Failure here shouldn't disable the app — just suppress the chip.
      set({ status: "error", errorMessage: msg });
    }
  },
}));
