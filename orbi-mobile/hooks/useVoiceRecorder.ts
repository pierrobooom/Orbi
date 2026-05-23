// Voice recording hook around expo-audio.
//
// Encapsulates microphone permission, audio session setup, and the
// useAudioRecorder lifecycle so the Universe screen just calls start() and
// stop() from its press handlers. Returns the recorded file URI on stop.
//
// Note: useAudioRecorder must be called at component top level — that's why
// this is a hook and not a plain service module.

import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import { useState } from "react";

export interface RecordingResult {
  uri: string;
  mimeType: string;
}

export function useVoiceRecorder() {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [isRecording, setIsRecording] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);

  const start = async (): Promise<boolean> => {
    setPermissionError(null);
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
      setIsRecording(true);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setPermissionError(`Could not start recording: ${msg}`);
      return false;
    }
  };

  const stop = async (): Promise<RecordingResult | null> => {
    if (!isRecording) return null;
    await recorder.stop();
    setIsRecording(false);
    const uri = recorder.uri;
    if (!uri) return null;
    // RecordingPresets.HIGH_QUALITY produces m4a/aac on iOS and mp4/aac on
    // Android. Backend /voice/transcribe accepts m4a explicitly.
    return { uri, mimeType: "audio/m4a" };
  };

  return { isRecording, permissionError, start, stop };
}
