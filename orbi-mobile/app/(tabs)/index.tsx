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

import { useT } from "@/i18n";
import BubbleCanvas from "@/components/universe/BubbleCanvas";
import EmptyState from "@/components/universe/EmptyState";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import {
  ApiError,
  chatMessage,
  isQuotaError,
  transcribeAudio,
  updateCluster,
  updateTask,
} from "@/services/api";
import { canCreateBubble, formatTurnsChip, isAtAiCap, isNearAiCap } from "@/services/tierGate";
import { firstPriority, needsYouToday } from "@/services/attention";
import { PriorityCard } from "@/components/universe/PriorityCard";
import { useLocaleStore } from "@/i18n";
import { useAuthStore } from "@/stores/authStore";
import { cue, startHum, stopHum } from "@/services/feedback";
import { useSoundStore } from "@/stores/soundStore";
import Feather from "@expo/vector-icons/Feather";
import { Avatar } from "@/components/avatar";
import { useProfileStore } from "@/stores/profileStore";
import { useUniverseStore } from "@/stores/universeStore";
import { useUsageStore } from "@/stores/usageStore";
import { colors } from "@/theme/colors";

/** One task as returned by the coordinator inside `data.tasks`. */
interface ParsedVoiceTask {
  title?: string;
  label?: string | null;
  description?: string | null;
  due_at?: string | null;
  parent_cluster_id?: string | null;
  importance?: number;
  confidence?: number;
}

export default function UniverseScreen() {
  const t = useT();
  const router = useRouter();
  const tier = useAuthStore((s) => s.tier);
  const setSearchResults = useUniverseStore((s) => s.setSearchResults);
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
  // The face in the corner. Loaded through the store so the header, the
  // settings button and the Settings screen all show the same thing without
  // three separate requests.
  const avatarUrl = useProfileStore((s) => s.avatarUrl);
  const profileName = useProfileStore((s) => s.name);
  const loadProfile = useProfileStore((s) => s.load);
  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  const lockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // What today asks of the user. Derived from the tasks already in the
  // store — the header count and the card come from the same function
  // call, so they can never disagree about what counts.
  const serverTasks = useUniverseStore((s) => s.serverTasks);
  const serverClusters = useUniverseStore((s) => s.serverClusters);
  const canvasClusters = useUniverseStore((s) => s.clusters);
  const language = useLocaleStore((s) => s.language);
  const now = new Date();
  const dueToday = needsYouToday(serverTasks, now);
  const priority = firstPriority(serverTasks, now);
  const priorityCluster = priority?.parent_cluster_id
    ? serverClusters.find((c) => c.id === priority.parent_cluster_id)
    : undefined;
  // Capitalised by hand: Portuguese weekday names are lower case
  // ("terça-feira"), which is correct in a sentence and wrong as a title.
  const rawWeekday = now.toLocaleDateString(language, { weekday: "long" });
  const weekday = rawWeekday.charAt(0).toUpperCase() + rawWeekday.slice(1);
  const auraColor =
    (activeClusterId
      ? canvasClusters.find((c) => c.id === activeClusterId)?.color
      : undefined) ?? colors.work;
  const showTurns = aiCapHit || isNearAiCap(usage);

  // The universe hum runs only while this screen is the one you are looking
  // at. Tied to focus rather than to app lifetime because it is scenery for
  // one place — hearing it over the Money tab would make it noise.
  const humOn = useSoundStore((s) => s.hum);
  useFocusEffect(
    useCallback(() => {
      if (humOn) startHum();
      return stopHum;
    }, [humOn]),
  );

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
    recordingStartedAt.current = null;
    const result = await voice.stop();
    // stop() returns null for a mis-tap and flags `tooShort` itself, so
    // the duration check lives in one place instead of four.
    if (!result) {
      if (voice.tooShort) setVoiceError(t("Keep the mic pressed to record."));
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
      // The coordinator returns parsed tasks in `data.tasks` when the
      // intent classifies as task creation. One utterance can produce
      // several ("book the dentist, call mum, buy milk"), so this is
      // always an array. If it's empty — e.g. the user said "hello" —
      // surface the chat reply so they understand why nothing was made.
      //
      // The bare-object shape is coordinator v1's and is still accepted;
      // a stale server would otherwise silently drop every capture.
      const raw = chat.data as
        | {
            tasks?: ParsedVoiceTask[];
            title?: string;
            // task_action shape — a command against tasks that already
            // exist rather than a new capture.
            action?: "complete" | "delete" | "update" | "list";
            resolved?: boolean;
            ambiguous?: boolean;
            target?: string;
            task?: { id: string; title: string };
            alternatives?: { id: string; title: string }[];
            patch?: Record<string, unknown>;
            task_ids?: string[];
          }
        | null;

      // A command about existing tasks. Nothing has been changed
      // server-side — route to confirmation, or straight to the universe
      // for a plain "what's overdue".
      if (raw?.action) {
        if (raw.action === "list") {
          const ids = raw.task_ids ?? [];
          if (ids.length === 0) {
            setVoiceError(chat.reply || t("Nothing matches that."));
          } else {
            // Reuse the search view — it already knows how to pull a set
            // of tasks into a focused cluster at canvas centre.
            setSearchResults(transcript, ids);
          }
          return;
        }
        if (!raw.resolved || !raw.task) {
          setVoiceError(chat.reply || t("Couldn't find that task."));
          return;
        }
        router.push({
          pathname: "/voice-action",
          params: {
            payload: JSON.stringify({
              action: raw.action,
              transcript,
              task: raw.task,
              ambiguous: raw.ambiguous ?? false,
              alternatives: raw.alternatives ?? [],
              patch: raw.patch ?? {},
            }),
          },
        });
        return;
      }
      const parsedTasks: ParsedVoiceTask[] = Array.isArray(raw?.tasks)
        ? raw!.tasks!.filter((t) => t && t.title)
        : raw && raw.title
          ? [raw as ParsedVoiceTask]
          : [];
      if (parsedTasks.length === 0) {
        setVoiceError(chat.reply || "Couldn't parse that as a task.");
        return;
      }
      const payload = {
        tasks: parsedTasks.map((t) => ({
          title: t.title,
          label: t.label ?? null,
          description: t.description ?? null,
          due_at: t.due_at ?? null,
          parent_cluster_id: t.parent_cluster_id ?? null,
          importance: t.importance,
          confidence: t.confidence,
        })),
        transcript,
      };
      router.push({
        pathname: "/voice-confirm",
        params: { payload: JSON.stringify(payload) },
      });
    } catch (e) {
      // A quota message is shown verbatim: it names the limit and when it
      // resets, which is information the user can act on. It used to end
      // "Tap the tier badge to upgrade" — the badge is gone, so it now
      // points at the place plans actually live.
      if (isQuotaError(e)) {
        cue("refuse");
        setVoiceError(`${e.message} ${t("Plans are in Settings.")}`);
      } else {
        // Everything else is infrastructure. String(e) put things like
        // "TypeError: Network request failed" in front of someone who only
        // wanted to talk to their phone — the same leak already fixed on
        // the chat mic. The detail goes to the console instead.
        console.warn("Voice capture failed:", e);
        setVoiceError(t("Couldn't use the mic just now. Try again."));
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
  const goOrganise = () => {
    closeArc();
    router.push("/cluster-proposal" as Href);
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
  // Third point of the arc: level with the +, out to its left.
  const organiseArcStyle = useAnimatedStyle(() => ({
    opacity: arcProgress.value,
    transform: [
      { translateX: (1 - arcProgress.value) * 72 },
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

  /** Remember where the user dropped a bubble.
   *
   * Fire-and-forget: the bubble is already sitting where they put it on the
   * UI thread, and blocking the gesture on a round trip — or bouncing it
   * back on a failed one — would make a smooth interaction feel unreliable
   * over a bad connection. A lost save costs one placement; the position is
   * re-sent the next time they move it.
   *
   * No refetch either. Hydrating here would rebuild the layout and fight
   * the placement that was just made.
   */
  const onBubbleMoved = useCallback(
    (kind: "cluster" | "task", id: string, x: number, y: number) => {
      const patch = { canvas_x: x, canvas_y: y };
      const save = kind === "cluster" ? updateCluster(id, patch) : updateTask(id, patch);
      save.catch(() => {
        // Silent: there is nothing the user can usefully do about it, and a
        // toast over a drag they have already finished is noise.
      });
    },
    [],
  );

  const openSettings = () => {
    router.push("/settings" as Href);
  };

  // One way to open a task, shared by bubble taps and the priority card.
  //
  // Two guards:
  //   1. navLocked — set whenever a detail modal is up or mid-close. Stops
  //      "push while the previous modal hasn't finished closing" from
  //      corrupting the navigation stack.
  //   2. a 500ms debounce — a safety net for rapid taps on overlapping
  //      bubbles.
  const openTask = (taskId: string) => {
    if (navLocked) return;
    const stamp = Date.now();
    if (stamp - lastBubbleTapAt.current < 500) return;
    lastBubbleTapAt.current = stamp;
    setNavLocked(true);
    router.push({ pathname: "/task-detail", params: { id: taskId } });
  };

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      {/* What day it is and how much of it is spoken for — the two things
          you want before deciding where to look. Controls sit on the right
          as outlined circles so they read as tools rather than as content. */}
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.weekday}>{weekday}</Text>
          <Text style={styles.todayLine}>
            {dueToday === 0
              ? t("Nothing due today")
              : dueToday === 1
                ? t("1 needs you today")
                : t("{n} need you today", { n: String(dueToday) })}
            {/* The AI allowance only earns header space when it is about to
                run out. Shown always, it was a running meter competing with
                the date for a decision the user could not make. */}
            {showTurns ? (
              <Text style={[styles.turnsChip, aiCapHit && styles.turnsChipFull]}>
                {"  ·  "}
                {turnsChip}
              </Text>
            ) : null}
          </Text>
        </View>
        <Pressable
          onPress={() => router.push("/search" as Href)}
          style={styles.circleBtn}
          accessibilityRole="button"
          accessibilityLabel={t("Search")}
        >
          <Feather name="search" size={17} color={colors.ink} />
        </Pressable>
        <Pressable
          onPress={openSettings}
          style={[styles.circleBtn, avatarUrl ? styles.circleBtnPhoto : null]}
          accessibilityRole="button"
          accessibilityLabel={t("Settings")}
        >
          {avatarUrl ? (
            <Avatar url={avatarUrl} name={profileName} size={36} />
          ) : (
            <Feather name="settings" size={17} color={colors.ink} />
          )}
        </Pressable>
      </View>

      <View style={styles.canvasWrap}>
        {universeStatus === "loading" || universeStatus === "idle" ? (
          <View style={styles.centered}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : universeStatus === "error" ? (
          <View style={styles.centered}>
            <Text style={styles.errorTitle}>{t("Could not load tasks")}</Text>
            <Text style={styles.errorBody}>{errorMessage ?? "Unknown error"}</Text>
            <Pressable onPress={() => hydrate()} style={styles.retryBtn}>
              <Text style={styles.retryText}>{t("Retry")}</Text>
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
            onTaskLongPress={(taskId) =>
              router.push({ pathname: "/move-task", params: { id: taskId } })
            }
            onClusterLongPress={onClusterLongPress}
            onBubbleMoved={onBubbleMoved}
            onEditFocusedCluster={(clusterId) =>
              router.push({ pathname: "/cluster-editor", params: { id: clusterId } })
            }
            onBubbleTap={openTask}
          />
        )}

        {voice.isRecording ? (
          <View pointerEvents="none" style={styles.recordingPill}>
            <View style={styles.recordingDot} />
            <Text style={styles.recordingText}>{t("Listening…")}</Text>
          </View>
        ) : null}

        {voiceStage === "processing" ? (
          <View pointerEvents="none" style={styles.processingOverlay}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.processingText}>{t("Parsing…")}</Text>
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

      </View>

      {/* The dock: what needs you, then the two ways to add something.
          In flow below the canvas rather than floating over it, so the
          universe lays its bubbles out in the space that is actually free
          instead of parking one underneath the card. */}
      <View style={styles.dock} pointerEvents="box-none">
        {priority && !activeClusterId && !arcOpen ? (
          <View style={styles.cardWrap}>
            <PriorityCard
              task={priority}
              clusterName={priorityCluster?.name ?? null}
              onPress={() => openTask(priority.id)}
            />
          </View>
        ) : null}

        <View style={styles.micRow} pointerEvents="box-none">
          {/* The mic is the centre of the app, so it sits in the centre.
              Ink, with an aura that takes the colour of the cluster you
              are inside — the universe tints the tool, not the reverse. */}
          <View style={styles.micWrap}>
            <View
              pointerEvents="none"
              style={[styles.micAura, { backgroundColor: auraColor }]}
            />
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
              <Feather name="mic" size={27} color={colors.canvas} />
            </Pressable>
          </View>

          {/* + and the three things it can make. Organise lives here now
              rather than as a separate button beside the mic: it is one
              more way of shaping the universe, and a third floating control
              made the bottom of the screen read as a toolbar. */}
          <View style={styles.plusWrap} pointerEvents="box-none">
            <Animated.View
              style={[styles.arcButtonTask, taskArcStyle]}
              pointerEvents={arcOpen ? "auto" : "none"}
            >
              <Pressable onPress={goNewTask} style={styles.arcInner}>
                <MaterialIcons name="add-task" size={22} color={colors.ink} />
              </Pressable>
              <Text style={styles.arcLabel}>{t("Task")}</Text>
            </Animated.View>
            <Animated.View
              style={[styles.arcButtonCluster, clusterArcStyle]}
              pointerEvents={arcOpen ? "auto" : "none"}
            >
              <Pressable onPress={goNewCluster} style={styles.arcInner}>
                <MaterialIcons name="bubble-chart" size={22} color={colors.ink} />
              </Pressable>
              <Text style={styles.arcLabel}>{t("Cluster")}</Text>
            </Animated.View>
            <Animated.View
              style={[styles.arcButtonOrganise, organiseArcStyle]}
              pointerEvents={arcOpen ? "auto" : "none"}
            >
              <Pressable onPress={goOrganise} style={styles.arcInner}>
                <MaterialIcons name="auto-awesome" size={21} color={colors.ink} />
              </Pressable>
              <Text style={styles.arcLabel}>{t("Organise")}</Text>
            </Animated.View>

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
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  header: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  headerText: { flex: 1 },
  weekday: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  todayLine: { color: colors.inkDim, fontSize: 13, marginTop: 1 },
  // 40pt circles with a hairline. Outlined rather than filled so they read
  // as tools sitting on the page, not as buttons competing with the mic.
  circleBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  // A photo fills its circle edge to edge; the outline would only draw a
  // second ring around the avatar's own.
  circleBtnPhoto: { borderWidth: 0 },
  turnsChip: { color: colors.inkDim, fontSize: 12, fontWeight: "500" },
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
  // In flow under the canvas. See the note in the JSX for why it no longer
  // floats over the bubbles.
  dock: { paddingBottom: 10 },
  cardWrap: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 12 },
  micRow: {
    height: 92,
    alignItems: "center",
    justifyContent: "center",
  },
  micWrap: {
    width: 74,
    height: 74,
    alignItems: "center",
    justifyContent: "center",
  },
  // A soft ring outside the mic, in the colour of wherever you are.
  micAura: {
    position: "absolute",
    width: 92,
    height: 92,
    borderRadius: 46,
    opacity: 0.16,
  },
  plusWrap: {
    position: "absolute",
    right: 22,
    top: 18,
    width: 56,
    height: 56,
  },
  // Tertiary action — smaller and quieter than the primary FAB pair
  // so it doesn't compete visually with the + and mic.
  // (Organise used to float here as its own button. It is in the + menu
  // now — see arcButtonOrganise.)
  fabMic: {
    width: 74,
    height: 74,
    borderRadius: 37,
    backgroundColor: colors.ink,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#14161C",
    shadowOpacity: 0.22,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 6,
  },
  fabMicActive: { backgroundColor: colors.overdue, borderColor: colors.overdue },
  fabDisabled: { opacity: 0.4 },
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
  // The arc fans out around the + as a quarter circle: straight up,
  // up-left, and level to the left. Offsets are from plusWrap.
  arcButtonTask: {
    position: "absolute",
    bottom: 74,
    right: 0,
    alignItems: "center",
    width: 56,
  },
  arcButtonCluster: {
    position: "absolute",
    bottom: 52,
    right: 62,
    alignItems: "center",
    width: 56,
  },
  arcButtonOrganise: {
    position: "absolute",
    bottom: -6,
    right: 76,
    alignItems: "center",
    width: 64,
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
    fontSize: 10.5,
    fontWeight: "600",
    marginTop: 4,
    textAlign: "center",
  },
  // Recording state pill — bottom-center, above the FAB row
  recordingPill: {
    position: "absolute",
    bottom: 16,
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
    bottom: 16,
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
    bottom: 16,
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
