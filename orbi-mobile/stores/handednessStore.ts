// Which hand is holding the phone.
//
// Orbi put Close in one top corner and Save in the other. Both sit outside
// the arc a thumb can sweep on a modern phone, and which corner is worse
// depends entirely on the hand — a fact the app had no way of knowing, so it
// guessed identically for everyone.
//
// WHAT THIS IS ALLOWED TO CHANGE
// Where a control sits. Never what it does, never whether it exists, never
// the reading order of text. Mirroring an interface is a seating plan, not a
// translation: an app that also reversed its labels or swapped the meaning of
// a swipe would be a different app for left-handed people, which is not the
// point.
//
// Seeded from the server preference at boot, exactly like the UI language,
// and updated immediately when the user flips the toggle so the change is
// visible before the save round-trips.

import { create } from "zustand";

export type Handedness = "right" | "left";

interface HandednessState {
  handedness: Handedness;
  setHandedness: (value: Handedness) => void;
}

export const useHandednessStore = create<HandednessState>((set) => ({
  // Right, because that is roughly nine people in ten. The point is not that
  // the default is clever — it is that the tenth can change it.
  handedness: "right",
  setHandedness: (handedness) => set({ handedness }),
}));

/** True when controls should be mirrored to the left.
 *
 * A hook rather than a raw store read so components re-render on change, and
 * so the intent reads clearly at the call site: `mirrored` says what it does
 * to a layout, where `handedness === "left"` makes the reader do the
 * translation every time.
 */
export function useMirrored(): boolean {
  return useHandednessStore((s) => s.handedness) === "left";
}
