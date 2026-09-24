// Re-draw the universe at the moment a task becomes overdue.
//
// WHY THIS EXISTS
// "Overdue" is not stored. It is decided at layout time by comparing each
// due_at with "now", and until this hook nothing laid the universe out again
// just because the clock moved — only when the user did something. So a task
// due at 18:00 stayed its normal colour while you watched 18:00 pass, and
// turned red whenever you next happened to touch the app.
//
// WHY ONE TIMER AND NOT POLLING
// A check every minute is the obvious fix and it is wrong twice over: it
// wakes the JS thread 1,440 times a day to find that nothing changed, and it
// is still up to 59 seconds late. The set of moments at which anything CAN
// change is known in advance — each future due time, plus midnight, when
// "today" rolls over — so this sets a single timeout for the nearest one,
// re-lays the universe out when it fires, and schedules the next.
//
// Nothing here touches the network. The server has not changed; only the
// time has, and the tasks needed to recompute are already in memory.

import { useEffect, useState } from "react";
import { AppState } from "react-native";

import { useUniverseStore } from "@/stores/universeStore";

// Never wait longer than this before re-checking. A single long timeout is
// fragile: phones sleep, clocks get corrected, time zones change on a
// flight. Waking at most every six hours costs nothing and bounds how wrong
// the screen can ever be.
const MAX_WAIT_MS = 6 * 60 * 60 * 1000;

// Fire just after the boundary, not on it. Timers can run a few ms early,
// and a check made at 17:59:59.998 would find the task still on time and
// then wait another whole interval.
const LATE_BY_MS = 250;

/** The next instant at which any task's overdue state or "today" changes. */
export function nextBoundary(
  dueTimes: (string | null | undefined)[],
  now: number,
): number {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  let next = midnight.getTime();
  for (const due of dueTimes) {
    if (!due) continue;
    const at = new Date(due).getTime();
    if (at > now && at < next) next = at;
  }
  return next;
}

export function useDueClock(): void {
  const serverTasks = useUniverseStore((s) => s.serverTasks);
  const clock = useUniverseStore((s) => s.clock);
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      const active = state === "active";
      setForeground(active);
      // Back from the background: the time may have jumped past any number
      // of boundaries while we were suspended, so catch up at once rather
      // than waiting on a timer that was frozen with the app.
      if (active) useUniverseStore.getState().relayout();
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    // A suspended app cannot draw anything, so it keeps no timer.
    if (!foreground) return;

    const now = Date.now();
    const active = serverTasks.filter((t) => t.status === "active");
    const at = nextBoundary(active.map((t) => t.due_at), now);
    const wait = Math.min(Math.max(at - now, 0) + LATE_BY_MS, MAX_WAIT_MS);

    const timer = setTimeout(() => {
      useUniverseStore.getState().relayout();
    }, wait);
    return () => clearTimeout(timer);
    // `clock` re-arms the timer after every relayout, including the one this
    // timer just caused; `serverTasks` re-arms it when a due date changes.
  }, [serverTasks, clock, foreground]);
}
