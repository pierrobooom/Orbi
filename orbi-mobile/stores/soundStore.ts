// Whether the app makes any sound, and whether the universe hums.
//
// WHY THIS IS PER-DEVICE AND NOT A SERVER PREFERENCE
// Handedness and language belong to the person: a new phone should already
// know them. Sound belongs to the handset. The phone on a desk at work and
// the one on the sofa want different answers, and syncing that choice
// between them would be the app overriding a decision made about the device
// in front of you.
//
// Two switches rather than one because they are different promises. Effects
// are momentary and tied to something you did; the hum is continuous and
// tied to nothing. Anyone who wants the first almost never wants the second,
// which is why it ships off.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";

import { setSoundEnabled } from "@/services/feedback";

const SOUND_KEY = "orbi.sound.effects";
const HUM_KEY = "orbi.sound.hum";

interface SoundState {
  effects: boolean;
  hum: boolean;
  /** True once the stored values have been read; screens wait for it so a
   * toggle never renders on and then flips off a frame later. */
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setEffects: (on: boolean) => void;
  setHum: (on: boolean) => void;
}

export const useSoundStore = create<SoundState>((set) => ({
  // On by default. The sounds are quiet, respect the silent switch and are
  // throttled — an app that ships its own character switched off is one
  // nobody discovers has any.
  effects: true,
  // Off by default. Ambience is a preference, never a default: a background
  // drone nobody asked for is the fastest way to lose the whole sound set.
  hum: false,
  hydrated: false,

  hydrate: async () => {
    try {
      const [effects, hum] = await Promise.all([
        AsyncStorage.getItem(SOUND_KEY),
        AsyncStorage.getItem(HUM_KEY),
      ]);
      const on = effects === null ? true : effects === "1";
      set({ effects: on, hum: hum === "1", hydrated: true });
      setSoundEnabled(on);
    } catch {
      // Storage that will not read leaves the defaults, which are safe.
      set({ hydrated: true });
    }
  },

  setEffects: (on) => {
    set({ effects: on });
    // Told immediately rather than read by the service: the next tap may be
    // milliseconds away, and it must already be silent.
    setSoundEnabled(on);
    AsyncStorage.setItem(SOUND_KEY, on ? "1" : "0").catch(() => {});
  },

  setHum: (on) => {
    set({ hum: on });
    AsyncStorage.setItem(HUM_KEY, on ? "1" : "0").catch(() => {});
  },
}));
