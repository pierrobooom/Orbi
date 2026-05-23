// Universe tab — the bubble canvas + a top status strip showing the
// daily quota (mocked for now) and a /health connectivity badge.

import { useRouter, type Href } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import BubbleCanvas from "@/components/universe/BubbleCanvas";
import EmptyState from "@/components/universe/EmptyState";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import {
  ApiError,
  chatMessage,
  getHealth,
  isQuotaError,
  transcribeAudio,
} from "@/services/api";
import { canCreateBubble, formatTurnsChip, isAtAiCap } from "@/services/tierGate";
import { useAuthStore, type SubscriptionTier } from "@/stores/authStore";
import { useUniverseStore } from "@/stores/universeStore";
import { useUsageStore } from "@/stores/usageStore";
import { colors } from "@/theme/colors";

type HealthBadge =
  | { status: "loading" }
  | { status: "ok"; app: string }
  | { status: "error"; message: string };

// Internal DB values stay 'free'|'pro'|'premium'; marketing names appear here.
const TIER_LABEL: Record<SubscriptionTier, string> = {
  free: "SPARK",
  pro: "PRO",
  premium: "GENIUS",
};

// Anything shorter than this isn't a real utterance — likely an
// accidental tap-and-release on the mic button.
const MIN_RECORDING_MS = 500;

export default function UniverseScreen() {
  const router = useRouter();
  const tier = useAuthStore((s) => s.tier);
  const signOut = useAuthStore((s) => s.signOut);
  const universeStatus = useUniverseStore((s) => s.status);
  const bubblesCount = useUniverseStore((s) => s.bubbles.length);
  const errorMessage = useUniverseStore((s) => s.errorMessage);
  const hydrate = useUniverseStore((s) => s.hydrate);
  const usage = useUsageStore((s) => s.usage);
  const hydrateUsage = useUsageStore((s) => s.hydrate);
  const [health, setHealth] = useState<HealthBadge>({ status: "loading" });

  const bubbleGate = canCreateBubble({ tier, bubbleCount: bubblesCount });
  const aiCapHit = isAtAiCap(usage);
  // Voice always involves an AI turn (chat parse) plus STT seconds, so
  // when the daily AI cap is exhausted we disable the mic too. The +
  // button is text-only and isn't blocked by an AI cap.
  const micDisabled = !bubbleGate.allowed || aiCapHit;
  const plusDisabled = !bubbleGate.allowed;
  const turnsChip = formatTurnsChip(usage);

  const voice = useVoiceRecorder();
  const recordingStartedAt = useRef<number | null>(null);
  const [voiceStage, setVoiceStage] = useState<"idle" | "processing">("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getHealth()
      .then((r) => !cancelled && setHealth({ status: "ok", app: r.app }))
      .catch((e) => !cancelled && setHealth({ status: "error", message: String(e.message ?? e) }));
    return () => {
      cancelled = true;
    };
  }, []);

  // Pull tasks + clusters once on mount. The store guards against
  // re-entry via its own status flag — but cheap to call again on a
  // remount, and that's exactly what we want when the user returns
  // from the create-task modal.
  useEffect(() => {
    hydrate();
    hydrateUsage();
  }, [hydrate, hydrateUsage]);

  const onMicPressIn = async () => {
    setVoiceError(null);
    if (!bubbleGate.allowed) {
      setVoiceError(bubbleGate.hint);
      return;
    }
    if (aiCapHit) {
      setVoiceError("Daily AI cap reached. Resets at midnight UTC.");
      return;
    }
    recordingStartedAt.current = Date.now();
    const ok = await voice.start();
    if (!ok) {
      recordingStartedAt.current = null;
      setVoiceError(voice.permissionError ?? "Could not start recording.");
    }
  };

  const onMicPressOut = async () => {
    const startedAt = recordingStartedAt.current;
    recordingStartedAt.current = null;
    const result = await voice.stop();
    if (!result) return;
    const duration = startedAt ? Date.now() - startedAt : 0;
    if (duration < MIN_RECORDING_MS) {
      setVoiceError("Hold the mic for at least half a second.");
      return;
    }

    setVoiceStage("processing");
    try {
      const { transcript } = await transcribeAudio(result.uri, result.mimeType);
      if (!transcript || transcript.trim().length === 0) {
        setVoiceError("Couldn't hear that. Try again.");
        return;
      }
      const chat = await chatMessage(transcript, "voice");
      // The chat coordinator returns parsed task fields in `data` when
      // the message intent classifies as task creation. If it didn't —
      // e.g. user said "hello" — surface the chat reply as an error so
      // they understand why nothing was created.
      const parsed = chat.data as
        | {
            title?: string;
            due_at?: string | null;
            parent_cluster_id?: string | null;
            importance?: number;
            confidence?: number;
          }
        | null;
      if (!parsed || !parsed.title) {
        setVoiceError(chat.reply || "Couldn't parse that as a task.");
        return;
      }
      const payload = {
        title: parsed.title,
        due_at: parsed.due_at ?? null,
        parent_cluster_id: parsed.parent_cluster_id ?? null,
        importance: parsed.importance,
        confidence: parsed.confidence,
        transcript,
      };
      router.push({
        pathname: "/voice-confirm",
        params: { payload: JSON.stringify(payload) },
      });
    } catch (e) {
      // Quota errors get the upgrade prompt; everything else falls
      // through to the raw API error message.
      if (isQuotaError(e)) {
        setVoiceError(`${e.message} Tap the tier badge to upgrade.`);
      } else {
        const msg = e instanceof ApiError ? e.message : String(e);
        setVoiceError(msg);
      }
    } finally {
      setVoiceStage("idle");
      // Refresh the usage chip so the user sees the burn from this turn.
      hydrateUsage();
    }
  };

  const onPlusPress = () => {
    if (!bubbleGate.allowed) {
      setVoiceError(bubbleGate.hint);
      return;
    }
    router.push("/new-task" as Href);
  };

  const onTierPress = () => {
    router.push("/upgrade" as Href);
  };

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.date}>Today</Text>
          <Pressable
            onPress={onTierPress}
            onLongPress={signOut}
            hitSlop={12}
            style={styles.tierPill}
            // Tap opens the upgrade modal. Long-press signs out (dev
            // affordance — replaced by a settings screen in a later
            // sprint).
          >
            <Text style={styles.tierPillText}>{TIER_LABEL[tier]}</Text>
          </Pressable>
          {turnsChip ? (
            <Text style={[styles.turnsChip, aiCapHit && styles.turnsChipFull]}>
              {turnsChip}
            </Text>
          ) : null}
        </View>
        <HealthChip health={health} />
      </View>

      <View style={styles.canvasWrap}>
        {universeStatus === "loading" || universeStatus === "idle" ? (
          <View style={styles.centered}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : universeStatus === "error" ? (
          <View style={styles.centered}>
            <Text style={styles.errorTitle}>Could not load tasks</Text>
            <Text style={styles.errorBody}>{errorMessage ?? "Unknown error"}</Text>
            <Pressable onPress={() => hydrate()} style={styles.retryBtn}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : bubblesCount === 0 ? (
          <EmptyState />
        ) : (
          <BubbleCanvas
            onBubbleTap={(taskId) =>
              router.push({
                pathname: "/task-detail",
                params: { id: taskId },
              })
            }
          />
        )}

        {voice.isRecording ? (
          <View pointerEvents="none" style={styles.recordingPill}>
            <View style={styles.recordingDot} />
            <Text style={styles.recordingText}>Listening…</Text>
          </View>
        ) : null}

        {voiceStage === "processing" ? (
          <View pointerEvents="none" style={styles.processingOverlay}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.processingText}>Parsing…</Text>
          </View>
        ) : null}

        {voiceError ? (
          <Pressable
            onPress={() => setVoiceError(null)}
            style={styles.errorToast}
            accessibilityLabel="Dismiss error"
          >
            <Text style={styles.errorToastText} numberOfLines={2}>
              {voiceError}
            </Text>
          </Pressable>
        ) : null}

        <View style={styles.fabRow}>
          <Pressable
            onPressIn={onMicPressIn}
            onPressOut={onMicPressOut}
            disabled={voiceStage === "processing" || micDisabled}
            style={[
              styles.fabMic,
              voice.isRecording && styles.fabMicActive,
              micDisabled && styles.fabDisabled,
            ]}
            hitSlop={6}
            accessibilityLabel="Hold to record voice task"
          >
            <Text style={styles.fabIcon}>🎙</Text>
          </Pressable>

          <Pressable
            onPress={onPlusPress}
            style={[styles.fabAdd, plusDisabled && styles.fabDisabled]}
            hitSlop={8}
            accessibilityLabel="Add task"
          >
            <Text style={styles.fabPlus}>+</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

function HealthChip({ health }: { health: HealthBadge }) {
  if (health.status === "loading") {
    return <Text style={styles.healthDim}>connecting…</Text>;
  }
  if (health.status === "ok") {
    return <Text style={styles.healthOk}>● backend ok</Text>;
  }
  return (
    <Text style={styles.healthErr} numberOfLines={1}>
      ● backend unreachable
    </Text>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  header: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
  date: { color: colors.ink, fontSize: 14, fontWeight: "600" },
  tierPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  tierPillText: { color: "white", fontSize: 9, fontWeight: "700", letterSpacing: 1 },
  turnsChip: { color: colors.inkDim, fontSize: 11, fontWeight: "500", marginLeft: 4 },
  turnsChipFull: { color: colors.overdue, fontWeight: "700" },
  healthOk: { color: colors.health, fontSize: 10 },
  healthDim: { color: colors.inkDim, fontSize: 10 },
  healthErr: { color: colors.overdue, fontSize: 10 },
  canvasWrap: { flex: 1, position: "relative" },
  centered: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  errorTitle: { color: colors.overdue, fontSize: 15, fontWeight: "600", marginBottom: 6 },
  errorBody: { color: colors.inkDim, fontSize: 12, textAlign: "center", marginBottom: 16 },
  retryBtn: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 999,
    borderColor: colors.line,
    borderWidth: 1,
  },
  retryText: { color: colors.ink, fontSize: 13, fontWeight: "600" },
  // FAB row sits the mic and + side-by-side bottom-right
  fabRow: {
    position: "absolute",
    right: 22,
    bottom: 22,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  fabMic: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  fabMicActive: { backgroundColor: colors.overdue, borderColor: colors.overdue },
  fabDisabled: { opacity: 0.4 },
  fabIcon: { fontSize: 22 },
  fabAdd: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  fabPlus: { color: "white", fontSize: 28, fontWeight: "300", marginTop: -2 },
  // Recording state pill — bottom-center, above the FAB row
  recordingPill: {
    position: "absolute",
    bottom: 92,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.panel,
    borderColor: colors.overdue,
    borderWidth: 1,
  },
  recordingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.overdue,
  },
  recordingText: { color: colors.ink, fontSize: 13, fontWeight: "600" },
  processingOverlay: {
    position: "absolute",
    bottom: 92,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
  },
  processingText: { color: colors.ink, fontSize: 13, fontWeight: "600" },
  errorToast: {
    position: "absolute",
    bottom: 92,
    left: 22,
    right: 22,
    backgroundColor: colors.panel,
    borderColor: colors.overdue,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  errorToastText: { color: colors.overdue, fontSize: 12 },
});
