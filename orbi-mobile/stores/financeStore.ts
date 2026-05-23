// Zustand store for the Money tab.
//
// Pulls entries + summary for the current month (UTC). Mirrors universeStore
// in shape — status flag, hydrate(), and an optimistic addEntry that lets
// the user see their new expense without waiting for a re-fetch.

import { create } from "zustand";

import {
  getFinanceSummary,
  listFinanceEntries,
  type FinanceSummary,
  type ServerFinanceEntry,
} from "@/services/api";

export type FinanceStatus = "idle" | "loading" | "ready" | "error";

function currentMonthKey(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

interface FinanceState {
  status: FinanceStatus;
  errorMessage: string | null;
  month: string;
  entries: ServerFinanceEntry[];
  summary: FinanceSummary | null;
  hydrate: () => Promise<void>;
  addEntry: (entry: ServerFinanceEntry) => void;
}

export const useFinanceStore = create<FinanceState>((set, get) => ({
  status: "idle",
  errorMessage: null,
  month: currentMonthKey(),
  entries: [],
  summary: null,

  hydrate: async () => {
    if (get().status === "idle") set({ status: "loading" });
    try {
      const month = currentMonthKey();
      const [entries, summary] = await Promise.all([
        listFinanceEntries(month),
        getFinanceSummary(month),
      ]);
      // Backend returns entries unordered; sort by date desc, then by
      // created_at desc as a tiebreaker so the latest entry of the day
      // sits at the top.
      const sorted = [...entries].sort((a, b) => {
        if (a.entry_date === b.entry_date) {
          return b.created_at.localeCompare(a.created_at);
        }
        return b.entry_date.localeCompare(a.entry_date);
      });
      set({
        status: "ready",
        errorMessage: null,
        month,
        entries: sorted,
        summary,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ status: "error", errorMessage: msg });
    }
  },

  addEntry: (entry) => {
    // Prepend the new entry and bump the summary total so the user sees
    // immediate feedback. A subsequent hydrate() will overwrite with the
    // server-authoritative numbers (including AI category corrections).
    const state = get();
    const sameMonth = entry.entry_date.startsWith(state.month);
    if (!sameMonth) {
      // Entry isn't for this month (user picked a different date).
      // Skip the optimistic local update; they'll see it when they
      // navigate to that month later.
      return;
    }
    const nextEntries = [entry, ...state.entries];
    const nextSummary: FinanceSummary | null = state.summary
      ? {
          ...state.summary,
          totals: {
            ...state.summary.totals,
            [entry.category]: (state.summary.totals[entry.category] ?? 0) + entry.amount,
          },
          total_spend:
            entry.entry_type === "expense"
              ? state.summary.total_spend + entry.amount
              : state.summary.total_spend,
          total_income:
            entry.entry_type === "income"
              ? state.summary.total_income + entry.amount
              : state.summary.total_income,
        }
      : null;
    set({ entries: nextEntries, summary: nextSummary });
  },
}));
