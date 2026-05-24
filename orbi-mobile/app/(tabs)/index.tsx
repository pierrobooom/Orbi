// Universe tab — the bubble canvas, the floating action menu, and a
// minimal header with a profile-icon shortcut into Settings. Backend
// health used to live up here; it now lives in Settings → Status.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useFocusEffect, useRouter, type Href } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";

import BubbleCanvas from "@/components/universe/BubbleCanvas";
import EmptyState from "@/components/universe/EmptyState";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import {
  ApiError,
  chatMessage,
  isQuotaError,
  transcribeAudio,
} from "@/services/api";
import { canCreateBubble, formatTurnsChip, isAtAiCap } from "@/services/tierGate";
import { useAuthStore, type SubscriptionTier } from "@/stores/authStore";
import { useUniverseStore } from "@/stores/universeStore";
import { useUsageStore } from "@/stores/usageStore";
import { colors } from "@/theme/colors";

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
  const universeStatus = useUniverseStore((s) => s.status);
  const bubblesCount = useUniverseStore((s) => s.bubbles.length);
  const activeClusterId = useUniverseStore((s) => s.activeClusterId);
  const errorMessage = useUniverseStore((s) => s.errorMessage);
  const hydrate = useUniverseStore((s) => s.hydrate);
  const usage = useUsageStore((s) => s.usage);
  const hydrateUsage = useUsageStore((s) => s.hydrate);

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
  // Cooldown timestamp for bubble taps — prevents rapid taps from
  // stacking multiple task-detail modals on top of each other.
  const lastBubbleTapAt = useRef<number>(0);
  // Hard lock that flips on whenever a detail modal is presented and
  // off ~300ms after this screen regains focus (the close animation
  // takes about that long). Without this lock, tapping another bubble
  // before the closing modal finished its animation produced a
  // glitch loop where modals opened/closed themselves.
  const [navLocked, setNavLocked] = useState(false);
  const lockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useFocusEffect(
    useCallback(() => {
      // Screen focused — close animation is done; release the lock
      // after a tiny settle delay so any late-fired tap during
      // animation still gets swallowed.
      if (lockTimer.current) clearTimeout(lockTimer.current);
      lockTimer.current = setTimeout(() => setNavLocked(false), 300);
      return () => {
        // Screen lost focus (a modal opened over it). Lock immediately
        // and cancel any pending unlock.
        if (lockTimer.current) clearTimeout(lockTimer.current);
        setNavLocked(true);
      };
    }, []),
  );
  const [voiceStage, setVoiceStage] = useState<"idle" | "processing">("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);


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
            label?: string | null;
            description?: string | null;
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
        label: parsed.label ?? null,
        description: parsed.description ?? null,
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

  // ----- Arc create menu -------------------------------------------------
  // Tapping + no longer routes straight to the task form — it now
  // toggles a small arc menu with two options (Task / Cluster) so
  // users can pick without leaving the canvas. Long-press still works
  // as a power-user shortcut to skip the menu.
  const [arcOpen, setArcOpen] = useState(false);
  const arcProgress = useSharedValue(0);

  const closeArc = () => {
    arcProgress.value = withTiming(0, { duration: 140 }, (finished) => {
      if (finished) runOnJS(setArcOpen)(false);
    });
  };
  const openArc = () => {
    setArcOpen(true);
    arcProgress.value = withTiming(1, { duration: 200 });
  };
  const togglePlus = () => {
    if (arcOpen) closeArc();
    else openArc();
  };

  const goNewTask = () => {
    closeArc();
    if (!bubbleGate.allowed) {
      setVoiceError(bubbleGate.hint);
      return;
    }
    router.push("/new-task" as Href);
  };
  const goNewCluster = () => {
    closeArc();
    router.push("/cluster-editor?id=new" as Href);
  };

  // Long-press → skip the menu, go straight to new cluster (the less
  // common action — long-press feels right for the shortcut).
  const onPlusLongPress = () => {
    router.push("/cluster-editor?id=new" as Href);
  };

  // + spins to a × when the arc is open. Same shared value drives
  // both the spin and the arc-button entry animations.
  const plusIconStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${arcProgress.value * 45}deg` }],
  }));
  // Arc buttons fade + scale in. The translate component carries them
  // up/up-left from + as the progress climbs, giving the arc reveal.
  const taskArcStyle = useAnimatedStyle(() => ({
    opacity: arcProgress.value,
    transform: [
      { translateX: (1 - arcProgress.value) * 22 },
      { translateY: (1 - arcProgress.value) * 50 },
      { scale: 0.6 + arcProgress.value * 0.4 },
    ],
  }));
  const clusterArcStyle = useAnimatedStyle(() => ({
    opacity: arcProgress.value,
    transform: [
      { translateX: (1 - arcProgress.value) * 60 },
      { translateY: (1 - arcProgress.value) * 60 },
      { scale: 0.6 + arcProgress.value * 0.4 },
    ],
  }));

  // Long-press on a cluster bubble → open the editor for that
  // cluster. Drift is filtered out because it's synthetic — the
  // editor will refuse it anyway, but blocking here avoids a
  // confusing navigation.
  const onClusterLongPress = (clusterId: string) => {
    if (clusterId === "synthetic-drift") return;
    router.push({ pathname: "/cluster-editor", params: { id: clusterId } });
  };

  const onTierPress = () => {
    router.push("/settings" as Href);
  };

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Pressable
            onPress={onTierPress}
            hitSlop={12}
            style={styles.profileBtn}
            accessibilityLabel="Open Settings"
          >
            <MaterialIcons
              name="account-circle"
              size={28}
              color={colors.ink}
            />
          </Pressable>
          {/* Tier still shows as a label next to the profile icon so
              the user can see which plan they're on at a glance.
              Backend health moved into Settings → Status to free up
              the canvas header. */}
          <Pressable
            onPress={onTierPress}
            hitSlop={12}
            style={styles.tierPill}
            accessibilityLabel="Subscription tier"
          >
            <Text style={styles.tierPillText}>{TIER_LABEL[tier]}</Text>
          </Pressable>
          {turnsChip ? (
            <Text style={[styles.turnsChip, aiCapHit && styles.turnsChipFull]}>
              {turnsChip}
            </Text>
          ) : null}
        </View>
        {/* Search icon top-right, mirror of the profile icon on the
            left. Single tap opens the search modal which embeds the
            query server-side and tags matching task IDs in the store. */}
        <Pressable
          onPress={() => router.push("/search" as Href)}
          hitSlop={12}
          style={styles.searchBtn}
          accessibilityLabel="Search"
        >
          <MaterialIcons name="search" size={26} color={colors.ink} />
        </Pressable>
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
        ) : bubblesCount === 0 && !activeClusterId ? (
          // Full empty state only fires at the top level. When the user
          // is drilled into an empty cluster we still render BubbleCanvas
          // so the back overlay (and an inline "no tasks yet" hint) is
          // visible — otherwise they'd be stranded with no way out.
          <EmptyState />
        ) : (
          <BubbleCanvas
            onClusterLongPress={onClusterLongPress}
            onEditFocusedCluster={(clusterId) =>
              router.push({ pathname: "/cluster-editor", params: { id: clusterId } })
            }
            onBubbleTap={(taskId) => {
              // Two guards:
              //   1. navLocked — set whenever a detail modal is up or
              //      mid-close-animation. Stops "push while previous
              //      modal hasn't finished closing" from corrupting
              //      the navigation stack.
              //   2. 500ms tap-debounce — secondary safety net for
              //      truly rapid taps on overlapping bubbles.
              if (navLocked) return;
              const now = Date.now();
              if (now - lastBubbleTapAt.current < 500) return;
              lastBubbleTapAt.current = now;
              setNavLocked(true);
              router.push({
                pathname: "/task-detail",
                params: { id: taskId },
              });
            }}
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

        {/* Tap-anywhere backdrop — only mounted when the arc is open.
            Lets the user tap outside the buttons to dismiss the menu
            without selecting anything. Sits above the canvas but
            below the FAB row so taps on +/mic still work. */}
        {arcOpen ? (
          <Pressable
            onPress={closeArc}
            style={StyleSheet.absoluteFill}
            accessibilityLabel="Close create menu"
          />
        ) : null}

        <View style={styles.fabRow} pointerEvents="box-none">
          {/* Arc menu — absolutely positioned above + when open. We
              mount the buttons unconditionally so their animations
              run on the same shared value, but pointerEvents="none"
              while closed makes them ignore taps. */}
          <Animated.View
            style={[styles.arcButtonTask, taskArcStyle]}
            pointerEvents={arcOpen ? "auto" : "none"}
          >
            <Pressable onPress={goNewTask} style={styles.arcInner}>
              <MaterialIcons name="add-task" size={22} color={colors.ink} />
            </Pressable>
            <Text style={styles.arcLabel}>Task</Text>
          </Animated.View>
          <Animated.View
            style={[styles.arcButtonCluster, clusterArcStyle]}
            pointerEvents={arcOpen ? "auto" : "none"}
          >
            <Pressable onPress={goNewCluster} style={styles.arcInner}>
              <MaterialIcons name="bubble-chart" size={22} color={colors.ink} />
            </Pressable>
            <Text style={styles.arcLabel}>Cluster</Text>
          </Animated.View>

          <Pressable
            onPress={() => router.push("/cluster-proposal" as Href)}
            style={styles.fabOrganise}
            hitSlop={6}
            accessibilityLabel="Organise clusters"
          >
            <MaterialIcons name="auto-awesome" size={20} color={colors.inkDim} />
          </Pressable>
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
            onPress={togglePlus}
            onLongPress={onPlusLongPress}
            style={[styles.fabAdd, plusDisabled && styles.fabDisabled]}
            hitSlop={8}
            accessibilityLabel={arcOpen ? "Close create menu" : "Create"}
          >
            <Animated.Text style={[styles.fabPlus, plusIconStyle]}>+</Animated.Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
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
  profileBtn: { padding: 2 },
  searchBtn: { padding: 4 },
  tierPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  tierPillText: { color: "white", fontSize: 9, fontWeight: "700", letterSpacing: 1 },
  turnsChip: { color: colors.inkDim, fontSize: 11, fontWeight: "500", marginLeft: 4 },
  turnsChipFull: { color: colors.overdue, fontWeight: "700" },
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
  // Tertiary action — smaller and quieter than the primary FAB pair
  // so it doesn't compete visually with the + and mic.
  fabOrganise: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 4,
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
  // Arc menu — buttons fan up + up-left from the + FAB. Positioned
  // absolutely relative to fabRow so they sit above the canvas. Each
  // wrapper holds the circular button + a small label below.
  arcButtonTask: {
    position: "absolute",
    bottom: 80,
    right: 6,
    alignItems: "center",
    width: 56,
  },
  arcButtonCluster: {
    position: "absolute",
    bottom: 64,
    right: 70,
    alignItems: "center",
    width: 56,
  },
  arcInner: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
  },
  arcLabel: {
    color: colors.ink,
    fontSize: 10,
    fontWeight: "600",
    marginTop: 4,
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.7)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
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
