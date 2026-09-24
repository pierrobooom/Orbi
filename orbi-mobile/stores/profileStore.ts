// The user's own name and picture, once, for the whole app.
//
// The avatar now appears in the universe header and in every screen's
// settings button, not only on the Settings screen. Fetching the profile
// from each of those would mean a request per screen for a value that
// changes about twice a year, and a visible pop as each one arrived
// separately.
//
// Deliberately not persisted. The URL points at a public object with a
// random name, so it is cheap to re-fetch and pointless to cache to disk;
// what matters is that it survives a reinstall, and it does, because it
// lives on the account.

import { create } from "zustand";

import { getMyProfile } from "@/services/api";

interface ProfileState {
  avatarUrl: string | null;
  name: string;
  username: string | null;
  usernameTag: number | null;
  loaded: boolean;
  load: () => Promise<void>;
  /** Applied straight away when the user changes their picture, so the
   * header updates without waiting for another round trip. */
  setAvatar: (url: string | null) => void;
  setUsername: (name: string | null, tag: number | null) => void;
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  avatarUrl: null,
  name: "",
  username: null,
  usernameTag: null,
  loaded: false,

  load: async () => {
    // Once per session is enough for a name and a picture. Re-entrant
    // callers (two screens mounting together) share the first result.
    if (get().loaded) return;
    try {
      const profile = await getMyProfile();
      set({
        avatarUrl: profile.avatar_url,
        name: profile.full_name || "",
        username: profile.username,
        usernameTag: profile.username_tag,
        loaded: true,
      });
    } catch {
      // Initials are a complete fallback, so a failed load is not worth
      // surfacing anywhere — the header simply shows a letter.
      set({ loaded: true });
    }
  },

  setAvatar: (url) => set({ avatarUrl: url }),
  setUsername: (name, tag) => set({ username: name, usernameTag: tag }),
}));
