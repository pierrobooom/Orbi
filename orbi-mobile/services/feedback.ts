// Sound and haptics — one place, so the rules are enforced once.
//
// WHY THIS IS A SERVICE AND NOT A play() CALL AT EACH SITE
// Every rule below is the kind that gets forgotten at the twentieth call
// site, and each one forgotten is a reason somebody turns the app's sound
// off for good:
//
//   - the silent switch always wins, with no exceptions;
//   - at most one sound every 120ms, so completing six things quickly is
//     one sound and not a queue of chimes;
//   - nothing during the user's own quiet hours, the same window that
//     already governs reminders;
//   - never over someone else's audio — drop to haptics instead of ducking
//     a podcast for a tick.
//
// HAPTICS ARE THE REAL CHANNEL
// Every cue has a haptic twin, and the haptic fires whether or not sound is
// on. Most people run a phone silent; the app has to feel complete that
// way, and the sound is the bonus rather than the message.

import * as Haptics from "expo-haptics";
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";

export type Cue =
  | "tap"
  | "complete"
  | "listen"
  | "listenStop"
  | "capture"
  | "refuse";

// require() rather than a path string: the bundler needs to see these to
// include them in the app, and a runtime-built path silently resolves to
// nothing in a release build.
const FILES: Record<Cue, number> = {
  tap: require("../assets/sounds/tap.wav"),
  complete: require("../assets/sounds/complete.wav"),
  listen: require("../assets/sounds/listen.wav"),
  listenStop: require("../assets/sounds/listen_stop.wav"),
  capture: require("../assets/sounds/capture.wav"),
  refuse: require("../assets/sounds/refuse.wav"),
};

// What each cue feels like. Chosen so the hand can tell them apart without
// the ear: success is a notification pattern, refusal is a warning, and
// everything routine is a light tap.
const HAPTICS: Record<Cue, () => Promise<void>> = {
  tap: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  complete: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  listen: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
  listenStop: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  capture: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  refuse: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
};

// Files are normalised to about -16 dBFS; this brings them down to roughly
// -24, which is where a UI sound stops competing with the content.
const VOLUME = 0.35;

// One sound per this many milliseconds. Six completions in a second is one
// chime, not six.
const THROTTLE_MS = 120;

let players: Partial<Record<Cue, AudioPlayer>> = {};
let lastPlayedAt = 0;
let soundEnabled = true;
let quietHours: { start: number; end: number } | null = null;
let ready = false;

/** Prepare the audio session and preload the cues.
 *
 * Called once at startup. Players are created up front because building one
 * on first use adds a delay to the very press the sound is meant to
 * acknowledge, which is exactly the press people judge the app on.
 */
export async function initFeedback(): Promise<void> {
  if (ready) return;
  ready = true;
  try {
    await setAudioModeAsync({
      // The silent switch must win. This is the single most important line
      // in the file: an app that chimes on a silenced phone is uninstalled.
      playsInSilentMode: false,
      // Sound effects sit alongside other audio rather than taking focus,
      // so nobody's music stops for a tick.
      interruptionMode: "mixWithOthers",
      shouldPlayInBackground: false,
    });
  } catch {
    // An audio session we cannot configure is one we must not play through:
    // the defaults may well ignore the silent switch.
    soundEnabled = false;
  }

  for (const cue of Object.keys(FILES) as Cue[]) {
    try {
      const player = createAudioPlayer(FILES[cue]);
      player.volume = VOLUME;
      players[cue] = player;
    } catch {
      // A cue that will not load simply has no sound. Its haptic still
      // fires, which is the half that carries the meaning.
    }
  }
}

/** Turn sound on or off. Haptics are unaffected, by design. */
export function setSoundEnabled(enabled: boolean): void {
  soundEnabled = enabled;
  // Switching sound off has to stop what is already playing, or the one
  // continuous sound in the app keeps going after the user asked for
  // silence — the single most irritating way to get this wrong.
  if (!enabled) stopHum();
}

/** The window during which the app stays silent.
 *
 * Hours in local time, matching the quiet hours that already govern
 * reminders — the app should be consistent about when it may speak, rather
 * than having one rule for notifications and another for itself.
 */
export function setQuietHours(start: number | null, end: number | null): void {
  quietHours = start === null || end === null ? null : { start, end };
}

function inQuietHours(now = new Date()): boolean {
  if (!quietHours) return false;
  const hour = now.getHours();
  const { start, end } = quietHours;
  // A window that wraps midnight (22 to 7) is the normal case, so it is
  // handled first rather than treated as the exception.
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

/** Fire a cue: haptic always, sound if it is allowed right now. */
export function cue(name: Cue): void {
  // Haptics first and unconditionally. They are silent, they work on a
  // muted phone, and they are the only feedback most people will get.
  HAPTICS[name]?.().catch(() => {});

  if (!soundEnabled || inQuietHours()) return;

  const now = Date.now();
  if (now - lastPlayedAt < THROTTLE_MS) return;
  lastPlayedAt = now;

  const player = players[name];
  if (!player) return;
  try {
    // Rewound every time: a player left at the end of its buffer plays
    // nothing at all on the second press, which reads as the sound
    // randomly failing.
    void player.seekTo(0);
    player.play();
  } catch {
    // Never let a sound effect break the interaction it was decorating.
  }
}

// The ambient bed. Separate from the cue players because it is the one
// sound that loops, the one that is off by default, and the one that must
// stop the moment you leave the universe rather than when it happens to end.
let humPlayer: AudioPlayer | null = null;

/** Start the universe hum, if it is not already running.
 *
 * Built lazily rather than at startup: it is off by default, and loading a
 * 100 KB loop for every user so that a minority can switch it on is the
 * wrong way round. Quieter than the cues — it is underneath everything
 * else, continuously, and anything louder becomes noticeable, which is
 * precisely what an ambient bed must not be.
 */
export function startHum(): void {
  if (humPlayer || !soundEnabled || inQuietHours()) return;
  try {
    humPlayer = createAudioPlayer(require("../assets/sounds/hum.wav"));
    humPlayer.loop = true;
    humPlayer.volume = 0.18;
    humPlayer.play();
  } catch {
    humPlayer = null;
  }
}

/** Stop the hum and release it. Safe to call when it never started. */
export function stopHum(): void {
  if (!humPlayer) return;
  try {
    humPlayer.remove();
  } catch {
    /* already gone */
  }
  humPlayer = null;
}

/** Release the players. Only for teardown in tests. */
export function disposeFeedback(): void {
  for (const player of Object.values(players)) {
    try {
      player?.remove();
    } catch {
      /* already gone */
    }
  }
  players = {};
  ready = false;
}
