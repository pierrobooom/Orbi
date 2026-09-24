// Light, night, or whatever the phone is set to.
//
// Per device, like sound: the phone on a bedside table and the one on a desk
// can reasonably want different answers, and syncing it would have one
// overrule the other.
//
// "System" is the default. People who have set their phone to switch at
// sunset have already told every app what they want; an app that ignores
// that and opens bright white at midnight is the one they notice.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { Appearance, type NativeEventSubscription } from "react-native";
import { create } from "zustand";

import { applyPalette, type ThemeName } from "@/theme/colors";

export type ThemeMode = "light" | "night" | "system";

const MODE_KEY = "orbi.theme.mode";

interface ThemeState {
  mode: ThemeMode;
  /** What is actually showing: "system" resolved against the phone. */
  resolved: ThemeName;
  /** Bumped on every palette change; the navigators key screens on it so
   * they remount and re-read their styles. */
  version: number;
  ready: boolean;
  hydrate: () => Promise<void>;
  setMode: (mode: ThemeMode) => void;
}

function resolve(mode: ThemeMode): ThemeName {
  if (mode !== "system") return mode;
  return Appearance.getColorScheme() === "dark" ? "night" : "light";
}

let appearanceSub: NativeEventSubscription | null = null;

export const useThemeStore = create<ThemeState>((set, get) => {
  const apply = (mode: ThemeMode) => {
    const resolved = resolve(mode);
    const version = applyPalette(resolved);
    set({ mode, resolved, version });
  };

  return {
    mode: "system",
    resolved: "light",
    version: 0,
    ready: false,

    hydrate: async () => {
      let mode: ThemeMode = "system";
      try {
        const stored = await AsyncStorage.getItem(MODE_KEY);
        if (stored === "light" || stored === "night" || stored === "system") {
          mode = stored;
        }
      } catch {
        // Unreadable storage falls back to following the phone, which is
        // the right answer for a user who has never chosen.
      }
      apply(mode);

      // Only listened to once, and only acted on while following the phone.
      // A person who picked Light explicitly keeps Light at sunset.
      if (!appearanceSub) {
        appearanceSub = Appearance.addChangeListener(() => {
          if (get().mode === "system") apply("system");
        });
      }
      set({ ready: true });
    },

    setMode: (mode) => {
      apply(mode);
      AsyncStorage.setItem(MODE_KEY, mode).catch(() => {});
    },
  };
});
