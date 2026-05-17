// Supabase client for Orbi mobile.
//
// Persists the session in expo-secure-store (Keychain on iOS,
// EncryptedSharedPreferences on Android) — never AsyncStorage, which is
// plaintext on Android and would leak the refresh token on a rooted device.
//
// SecureStore has a 2 KB value cap; Supabase sessions fit comfortably under
// that, but we serialize to JSON to keep the adapter contract simple.

import { createClient } from "@supabase/supabase-js";
import * as SecureStore from "expo-secure-store";
import { AppState, Platform } from "react-native";

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  // Fail loud at module load — better than a confusing "Invalid API key" at
  // first sign-in attempt. The dev sees this in the Metro console.
  throw new Error(
    "Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY. " +
      "Copy values from orbi-backend/.env into orbi-mobile/.env.local and restart Expo.",
  );
}

// Three runtimes touch this module:
//   1. iOS / Android — use Keychain / EncryptedSharedPreferences via SecureStore.
//   2. Web in the browser — use window.localStorage.
//   3. Web in Node during Expo's static pre-render — no window, no Keychain.
//      Use an in-memory stub; nothing persists, which is fine for SSR (the
//      bundle runs again on the client with the real adapter).
const isNodeSsr = typeof window === "undefined" && Platform.OS === "web";

const memoryStorage = (() => {
  const store = new Map<string, string>();
  return {
    getItem: async (key: string) => store.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: async (key: string) => {
      store.delete(key);
    },
  };
})();

const browserStorage = {
  getItem: async (key: string) => window.localStorage.getItem(key),
  setItem: async (key: string, value: string) => {
    window.localStorage.setItem(key, value);
  },
  removeItem: async (key: string) => {
    window.localStorage.removeItem(key);
  },
};

const nativeStorage = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

const secureStorageAdapter = isNodeSsr
  ? memoryStorage
  : Platform.OS === "web"
    ? browserStorage
    : nativeStorage;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: secureStorageAdapter,
    autoRefreshToken: true,
    persistSession: true,
    // No URL detection — RN has no window.location. OAuth deep-link sessions
    // are picked up explicitly when we add Google in the next slice.
    detectSessionInUrl: false,
  },
});

// Supabase's autoRefreshToken timer only runs while JS is awake. Pause it in
// the background to avoid stale fetches, resume on foreground. Standard
// supabase-js + Expo pattern — without this, sessions silently expire while
// the app is backgrounded for long periods.
//
// Skip the listener entirely during Expo's static pre-render where there's
// no real app lifecycle to listen to and AppState's polyfill can crash.
if (!isNodeSsr) {
  AppState.addEventListener("change", (state) => {
    if (state === "active") {
      supabase.auth.startAutoRefresh();
    } else {
      supabase.auth.stopAutoRefresh();
    }
  });
}
