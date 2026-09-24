// Every duration, easing and spring the app is allowed to use.
//
// WHY THREE SPEEDS AND NOT A SCALE
// A motion scale with eight steps means eight judgement calls per screen and
// eight slightly different answers. Three named speeds can be chosen
// correctly without thinking: is this a press, a navigation, or a moment?
//
// Nothing here exceeds 400ms. Past that a transition stops being feedback
// and becomes something you wait for, and a to-do app that makes you wait
// for its own confidence trick is one you stop opening.

import { Easing, ReduceMotion, withSpring, withTiming } from "react-native-reanimated";

/** Press, toggle, ripple — feedback that must feel instant. */
export const MICRO = 120;

/** Sheets, tabs, navigation — the workhorse. */
export const STANDARD = 220;

/** Completion, entering a cluster — the few moments worth a beat. */
export const EXPRESSIVE = 380;

/** Decelerating, with no overshoot.
 *
 * Fast out of the gate and settling at the end, which reads as the
 * interface responding rather than the interface animating. Used for
 * everything that is not a bubble. */
export const EASE = Easing.bezier(0.2, 0, 0, 1);

/** How bubbles move.
 *
 * Bubbles are the one thing with apparent mass, so they get a spring rather
 * than a curve. Damping 15 against stiffness 180 settles in roughly 400ms
 * with a trace of overshoot — enough to read as physical, not enough to
 * wobble. These are the same numbers the drag gesture already used; they
 * live here now so nothing invents its own. */
export const SPRING = { damping: 15, stiffness: 180 } as const;

/** A springier version for pick-up and drop, where overshoot is the point. */
export const SPRING_LIVELY = { damping: 14, stiffness: 200 } as const;

/** A timing animation that respects the system Reduce Motion setting.
 *
 * ReduceMotion.System makes Reanimated finish the animation immediately
 * when the flag is on, so callers get the end state without writing a
 * branch. Decorative loops still have to be switched off by hand — see
 * useReduceMotion — because an instant loop is still a loop. */
export function timing(toValue: number, duration: number = STANDARD) {
  "worklet";
  return withTiming(toValue, {
    duration,
    easing: EASE,
    reduceMotion: ReduceMotion.System,
  });
}

/** A spring that respects Reduce Motion, for anything with mass. */
export function spring(toValue: number, config = SPRING) {
  "worklet";
  return withSpring(toValue, { ...config, reduceMotion: ReduceMotion.System });
}

/** Named animations, so a screen asks for a behaviour rather than a number.
 *
 * The values are what the design proposal specifies; changing one here
 * changes it everywhere it is used, which is the entire reason they are not
 * written inline at each call site. */
export const PRESS_SCALE = 0.94;
export const POP_SCALE = 1.22;

/** Bubble breathing: how far, and over how long.
 *
 * Two per cent, because the point is that the universe looks alive rather
 * than that anything appears to be happening. Seven seconds is slow enough
 * that the eye never tracks it, and each bubble is phase-offset so the
 * field does not pulse in unison — a synchronised pulse looks like a fault. */
export const BREATHE_SCALE = 0.02;
export const BREATHE_MS = 7000;

/** The overdue halo — the only looping alarm in the app. */
export const PULSE_MS = 2400;
