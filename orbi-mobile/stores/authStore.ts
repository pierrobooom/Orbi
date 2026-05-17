// Auth state for the mobile app.
//
// Subscribes once to supabase.auth.onAuthStateChange and mirrors the session
// into a Zustand store so screens can read it synchronously without awaiting
// getSession() every render. The store is the single source of truth for
// "are we signed in" and "what tier are we"; the JWT itself stays inside
// supabase-js (we never copy it into store state to avoid stale tokens).
//
// Internal tier values stay as Supabase has them: 'free' | 'pro' | 'premium'.
// Marketing names (Spark / Pro / Genius) are mapped at the UI boundary.

import type { Session } from "@supabase/supabase-js";
import { create } from "zustand";

import { supabase } from "@/services/supabase";

export type SubscriptionTier = "free" | "pro" | "premium";

interface AuthState {
  // null until the first onAuthStateChange fires (INITIAL_SESSION).
  // After that, null means "signed out" and an object means "signed in".
  session: Session | null;
  // True until the initial session has been read from SecureStore. The root
  // layout uses this to keep the splash up so we don't flash sign-in for
  // half a second before redirecting back to the Universe.
  bootstrapping: boolean;
  tier: SubscriptionTier;
  signOut: () => Promise<void>;
}

function deriveTier(session: Session | null): SubscriptionTier {
  const raw = session?.user.app_metadata?.subscription_tier;
  if (raw === "pro" || raw === "premium") return raw;
  return "free";
}

export const useAuthStore = create<AuthState>((set) => ({
  session: null,
  bootstrapping: true,
  tier: "free",
  signOut: async () => {
    await supabase.auth.signOut();
    // onAuthStateChange will fire SIGNED_OUT and clear the session.
  },
}));

// Subscribe once at module load. supabase-js fires INITIAL_SESSION immediately
// with whatever it pulled from SecureStore, which doubles as our "bootstrap
// finished" signal.
supabase.auth.onAuthStateChange((_event, session) => {
  useAuthStore.setState({
    session,
    bootstrapping: false,
    tier: deriveTier(session),
  });
});
