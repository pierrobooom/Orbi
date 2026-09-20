// Re-fetch when the app comes back to the foreground.
//
// WHY useFocusEffect IS NOT ENOUGH
// Screen focus and app foreground are different events. Backgrounding the app
// does not unfocus the screen you were on, so coming back fires no focus
// effect at all — the screen never lost focus, it just stopped being visible.
//
// That is precisely the gap behind "I postpone from the notification, come
// back, and the bubble still shows the old time and is still pulsing red".
// The server had already moved the task; the app was showing a snapshot taken
// before the user ever left, and only a full reload picked it up.
//
// It matters most for exactly the actions that happen OUTSIDE the app:
// notification buttons. Those change server state while the app is
// backgrounded or suspended, so the client's copy is guaranteed stale on
// return — and the user, who just pressed a button, is the one person certain
// something should have changed.
//
// Cheap enough to be unconditional: two GETs when the app is opened, which is
// far less traffic than the pull-to-refresh it replaces.

import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";

import { useAuthStore } from "@/stores/authStore";
import { useFinanceStore } from "@/stores/financeStore";
import { useUniverseStore } from "@/stores/universeStore";

// Returning after a few seconds — glancing at Control Centre, dismissing a
// notification — cannot have changed anything server-side, and refetching on
// every such blink would make the canvas flicker for no reason.
const MIN_BACKGROUND_MS = 3000;

export function useRefreshOnForeground() {
  const session = useAuthStore((s) => s.session);
  const backgroundedAt = useRef<number | null>(null);

  useEffect(() => {
    if (!session) return;

    const onChange = (next: AppStateStatus) => {
      if (next === "background" || next === "inactive") {
        // Only stamp the first transition: iOS emits `inactive` on the way
        // into the background AND on the way out, and overwriting here would
        // reset the clock to zero on every return.
        if (backgroundedAt.current === null) {
          backgroundedAt.current = Date.now();
        }
        return;
      }

      if (next !== "active") return;

      const away = backgroundedAt.current;
      backgroundedAt.current = null;
      if (away === null || Date.now() - away < MIN_BACKGROUND_MS) return;

      // Failures are silent on purpose. This runs on every app open, and a
      // transient network error here must not throw an error state over a
      // screen the user was already looking at happily.
      void useUniverseStore.getState().hydrate().catch(() => {});
      void useFinanceStore.getState().hydrate().catch(() => {});
    };

    const subscription = AppState.addEventListener("change", onChange);
    return () => subscription.remove();
  }, [session]);
}
