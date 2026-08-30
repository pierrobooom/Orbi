// Voice recording hook around expo-audio.
//
// Encapsulates microphone permission, audio session setup, and the
// useAudioRecorder lifecycle so screens just call start() and stop() from
// their press handlers. Returns the recorded file URI on stop.
//
// Note: useAudioRecorder must be called at component top level — that's why
// this is a hook and not a plain service module.
//
// Fast taps are the hard case and the reason for the refs below. start()
// is several awaits deep (permission -> audio session -> prepare -> record)
// and only flips React state at the end. A quick tap fires stop() long
// before that, and the previous version guarded stop() on the `isRecording`
// STATE — which was still false — so it returned immediately without
// stopping anything. start() then completed and left the recorder running
// with the UI showing idle; the next tap called prepareToRecordAsync on a
// live recorder and threw. Refs give stop() a synchronous truth to read,
// and awaiting the in-flight start promise means a tap that outruns
// start() still stops cleanly.

import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import { useRef, useState } from "react";

export interface RecordingResult {
  uri: string;
  mimeType: string;
  durationMs: number;
}

// Below this a recording is a mis-tap, not speech. Deepgram would return
// an empty transcript and the user would get a confusing failure.
export const MIN_RECORDING_MS = 500;

export function useVoiceRecorder() {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [isRecording, setIsRecording] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  // Set when a press was too brief to be speech. Callers surface it as a
  // hint ("hold the mic") rather than an error — it's a usage nudge, not
  // a failure.
  const [tooShort, setTooShort] = useState(false);

  // Synchronous mirrors of the async lifecycle. State drives rendering;
  // these drive control flow.
  const isRecordingRef = useRef(false);
  const startPromiseRef = useRef<Promise<boolean> | null>(null);
  const startedAtRef = useRef<number | null>(null);

  const start = async (): Promise<boolean> => {
    setPermissionError(null);
    setTooShort(false);

    // Ignore a second press while one is already live or starting —
    // prepareToRecordAsync on an active recorder throws.
    if (isRecordingRef.current || startPromiseRef.current) return false;

    const run = async (): Promise<boolean> => {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setPermissionError(
          "Microphone permission denied. Enable it in iOS Settings to use voice.",
        );
        return false;
      }
      try {
        // iOS audio sessions are picky. interruptionMode +
        // shouldRouteThroughEarpiece + shouldPlayInBackground are all
        // required (the type is Partial but the native side wants the
        // full picture) for the session category to flip to playAndRecord.
        // prepareToRecordAsync activates the session itself; calling
        // setIsAudioActiveAsync separately racing against it fails with
        // "setIsAudioActiveAsync function has failed".
        await setAudioModeAsync({
          playsInSilentMode: true,
          allowsRecording: true,
          // Coexist with other apps' audio — music, podcasts, calls keep
          // playing at full volume while we capture. doNotMix (exclusive
          // lock) would pause whatever else is playing, which is rude for
          // a 2-second task-capture interaction.
          interruptionMode: "mixWithOthers",
          shouldPlayInBackground: false,
          shouldRouteThroughEarpiece: false,
        });
        await recorder.prepareToRecordAsync();
        recorder.record();
        isRecordingRef.current = true;
        startedAtRef.current = Date.now();
        setIsRecording(true);
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setPermissionError(`Could not start recording: ${msg}`);
        return false;
      }
    };

    const promise = run();
    startPromiseRef.current = promise;
    try {
      return await promise;
    } finally {
      startPromiseRef.current = null;
    }
  };

  /** Stop and return the recording, or null.
   *
   * Returns null when nothing was recording, when the press was shorter
   * than MIN_RECORDING_MS (sets `tooShort`), or when no file landed. In
   * every one of those cases the recorder is left genuinely stopped —
   * that guarantee is what the previous version broke.
   */
  const stop = async (): Promise<RecordingResult | null> => {
    // A tap fast enough to beat start()'s awaits: wait for it to settle
    // so we don't return while a recorder is about to spin up.
    if (startPromiseRef.current) {
      try {
        await startPromiseRef.current;
      } catch {
        // start() reports its own failure via permissionError.
      }
    }

    if (!isRecordingRef.current) return null;

    const startedAt = startedAtRef.current;
    startedAtRef.current = null;
    isRecordingRef.current = false;

    try {
      await recorder.stop();
    } catch {
      // Already stopped by the OS (interruption, call). Nothing to do —
      // the state below still has to be cleared.
    }
    setIsRecording(false);

    const durationMs = startedAt ? Date.now() - startedAt : 0;
    if (durationMs < MIN_RECORDING_MS) {
      setTooShort(true);
      return null;
    }

    const uri = recorder.uri;
    if (!uri) return null;
    // RecordingPresets.HIGH_QUALITY produces m4a/aac on iOS and mp4/aac on
    // Android. Backend /voice/transcribe accepts m4a explicitly.
    return { uri, mimeType: "audio/m4a", durationMs };
  };

  const clearHints = () => {
    setTooShort(false);
    setPermissionError(null);
  };

  return { isRecording, permissionError, tooShort, start, stop, clearHints };
}
