// Whether the person has asked the system to reduce motion.
//
// Reanimated's ReduceMotion.System handles one-shot animations by itself —
// they jump to their end state. It cannot help with a LOOP, because an
// instantly-completing loop still loops. Breathing bubbles, the overdue
// halo and the mic aura all have to be switched off at the source, and this
// is what tells them to.
//
// The rule behind it: nothing may be communicated by movement alone. An
// overdue task is red and carries a red dot whether or not it pulses, so
// turning every loop off costs no information — which is what makes it safe
// to turn them all off rather than picking favourites.

import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

export function useReduceMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let alive = true;

    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (alive) setReduced(value);
      })
      // A platform that cannot answer is treated as "do not reduce": the
      // animations are the designed experience, and silently flattening
      // them because a query failed would be the worse default.
      .catch(() => {});

    const sub = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      // Listened for rather than read once, because people turn this on
      // mid-session — often precisely because something on screen is
      // bothering them right now.
      (value) => setReduced(value),
    );

    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  return reduced;
}
