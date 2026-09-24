// Bubble detail bottom sheet — slides up when the user taps a bubble.
//
// Reads the task by id from universeStore.serverTasks (no network call —
// we already have the full record locally). View mode shows title,
// cluster, importance, due, pressure. Edit mode swaps in inputs so the
// user can fix a bad parse instead of deleting and re-recording.
//
// Actions:
//   - View mode: Edit | Delete | Mark complete
//   - Edit mode: Cancel | Save changes

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import DateTimePicker from "@react-native-community/datetimepicker";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { ScreenHeader } from "@/components/screen-header";
import { ShareTaskSheet } from "@/components/share-task-sheet";
import { translate, useT } from "@/i18n";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import {
  ApiError,
  deleteTask,
  transcribeAudio,
  completeTask,
  getTaskSharing,
  updateTask,
  type SharingState,
  voiceUpdateTask,
} from "@/services/api";
import { useUniverseStore } from "@/stores/universeStore";
import { dismissDeliveredFor } from "@/hooks/useNotificationActions";
import { colors } from "@/theme/colors";
import { cue } from "@/services/feedback";

// Mark-complete hold duration. Keeps the user from accidentally
// completing a task with a stray tap.
const HOLD_TO_COMPLETE_MS = 2000;

const SYNTHETIC_DRIFT_ID = "synthetic-drift";

const IMPORTANCE_LABELS: Record<number, string> = {
  10: "Critical", 9: "Critical", 8: "Critical",
  7: "Important", 6: "Important",
  5: "Normal", 4: "Normal",
  3: "Low", 2: "Low", 1: "Low",
};

export default function TaskDetailScreen() {
  const t = useT();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const taskId = Array.isArray(id) ? id[0] : id;

  const removeTask = useUniverseStore((s) => s.removeTask);
  const replaceTask = useUniverseStore((s) => s.replaceTask);
  // Canvas-shaped clusters (carries `name` + color in the same shape
  // the chip uses), but indexed via serverClusters too so the lookup
  // works in search view / drilled view where the canvas list is
  // filtered down to just one cluster.
  const clusters = useUniverseStore((s) => s.clusters);
  const serverClusters = useUniverseStore((s) => s.serverClusters);

  // Subscribe directly to serverTasks so this screen re-renders when
  // replaceTask() lands a Save. The earlier useMemo over a stable
  // getServerTask reference never re-ran and the user had to close
  // and reopen the sheet to see their edits.
  const task = useUniverseStore((s) =>
    taskId ? s.serverTasks.find((t) => t.id === taskId) : undefined,
  );
  // Look up the task's cluster via serverClusters (the full list,
  // always populated) rather than `clusters` (the canvas state,
  // which only contains the synthetic search/drilled cluster when
  // those modes are active — search results that came from a real
  // cluster would otherwise show "No cluster").
  const currentCluster = useMemo(() => {
    if (!task?.parent_cluster_id) return undefined;
    return serverClusters.find((c) => c.id === task.parent_cluster_id);
  }, [task, serverClusters]);

  const [mode, setMode] = useState<"view" | "edit">("view");
  // Who else is on this task and where the completion vote stands. Null
  // until loaded, and null forever for a task nobody shares — the screen
  // must not grow a "0 of 1 agreed" line for an ordinary task.
  const [sharing, setSharing] = useState<SharingState | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const isCompleted = task?.status === "completed";
  const [busy, setBusy] = useState<"complete" | "delete" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Hold-to-complete progress (0 to 1). Drives the fill bar inside the
  // Mark complete button and triggers onMarkComplete when it reaches 1.
  const holdProgress = useSharedValue(0);
  const holdFillStyle = useAnimatedStyle(() => ({
    width: `${holdProgress.value * 100}%`,
  }));

  // Edit-mode local state — initialised from the task on entry.
  const [editTitle, setEditTitle] = useState("");
  const [editLabel, setEditLabel] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editDueAt, setEditDueAt] = useState<Date | null>(null);
  const [editClusterId, setEditClusterId] = useState<string | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);

  // Voice-dictate-title: hold the mic to record, release to transcribe
  // and drop the transcript into the title input. No LLM parse pass —
  // this is plain dictation. Field-aware voice edits (e.g. "change due
  // to Tuesday") land in a follow-up slice.
  const voice = useVoiceRecorder();
  const voiceStartedAt = useRef<number | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  if (!task) {
    return (
      <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
        <View style={styles.centered}>
          <Text style={styles.title}>{t("Task not found")}</Text>
          <Pressable onPress={() => router.back()} style={styles.secondary}>
            <Text style={styles.secondaryText}>{t("Close")}</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // Has THIS user already said it is done? Their vote lives in a different
  // place depending on whether they own the task or were invited to it, and
  // the screen has to answer the same question either way.
  const iSaidDone = Boolean(
    task?.shared_with_me ? task?.i_completed_at : task?.owner_completed_at,
  );

  const refreshSharing = useCallback(async () => {
    if (!taskId) return;
    try {
      const state = await getTaskSharing(taskId);
      // Only kept when there is actually something shared. A solo task
      // returns participants: 1, and rendering that as a vote would invent
      // a social feature on a private to-do.
      setSharing(state.participants > 1 || state.shares.length > 0 ? state : null);
    } catch {
      setSharing(null);
    }
  }, [taskId]);

  useEffect(() => {
    void refreshSharing();
  }, [refreshSharing]);

  const enterEdit = () => {
    setError(null);
    setEditTitle(task.title);
    setEditLabel(task.label ?? "");
    setEditDescription(task.description ?? "");
    setEditDueAt(task.due_at ? new Date(task.due_at) : null);
    setEditClusterId(task.parent_cluster_id ?? null);
    setMode("edit");
  };

  const cancelEdit = () => {
    setMode("view");
    setError(null);
    setShowDatePicker(false);
  };

  const onSave = async () => {
    if (!editTitle.trim()) {
      setError("Title can't be empty.");
      return;
    }
    setError(null);
    setVoiceError(null);
    setBusy("save");
    try {
      const trimmedDescription = editDescription.trim();
      const trimmedLabel = editLabel.trim();
      const updated = await updateTask(task.id, {
        title: editTitle.trim(),
        label: trimmedLabel.length > 0 ? trimmedLabel : null,
        description: trimmedDescription.length > 0 ? trimmedDescription : null,
        due_at: editDueAt ? editDueAt.toISOString() : null,
        parent_cluster_id: editClusterId,
      });
      replaceTask(updated);
      setMode("view");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  /** Say this is done — which on a shared task is a vote, not a verdict.
   *
   * The same gesture does both, because from the user's side the intent is
   * identical: this is finished. What changes is the consequence, and the
   * screen has to be honest about it — closing the sheet and removing the
   * bubble when the task is still open for two other people would be the
   * app telling them something untrue about their own list.
   */
  const onMarkComplete = async () => {
    setError(null);
    setBusy("complete");
    try {
      const state = await completeTask(task.id);
      if (state.complete) {
        // Only when it actually closed. On a shared task that still needs
        // other people, a reward sound would be celebrating something that
        // has not happened.
        cue("complete");
        // The task is closed, so any reminder about it still sitting in
        // Notification Centre is now asking about something that is done.
        // Acting from a notification already clears these; finishing the
        // same task in the app should leave the tray in the same state,
        // or the user gets nagged about work they just did here.
        await dismissDeliveredFor(task.id);
        removeTask(task.id);
        router.back();
        return;
      }
      // Still open. Stay put, show where the vote stands, and let them see
      // that their part is done.
      setSharing(state);
      setBusy(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(null);
    }
  };

  // A completed task offers Reopen instead of Complete. Previously the
  // hold-to-complete button was shown regardless of status, so completing
  // an already-completed task from the Done view simply made it vanish
  // from that view — a no-op that looked like data loss.
  const onReopen = async () => {
    setError(null);
    setBusy("complete");
    try {
      // The API clears completed_at on the way out of 'completed', so a
      // reopened task doesn't keep a stale completion date.
      const updated = await updateTask(task.id, { status: "active" });
      replaceTask(updated);
      router.back();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(null);
    }
  };

  const onHoldStart = () => {
    if (busy) return;
    holdProgress.value = withTiming(
      1,
      { duration: HOLD_TO_COMPLETE_MS },
      (finished) => {
        // `finished` is false when cancelAnimation interrupted the
        // timing; we only fire onMarkComplete when the user held the
        // button to the very end.
        if (finished) {
          runOnJS(onMarkComplete)();
        }
      },
    );
  };

  const onHoldEnd = () => {
    cancelAnimation(holdProgress);
    holdProgress.value = withTiming(0, { duration: 200 });
  };

  const onMicPressIn = async () => {
    setVoiceError(null);
    voiceStartedAt.current = Date.now();
    const ok = await voice.start();
    if (!ok) {
      voiceStartedAt.current = null;
      setVoiceError(voice.permissionError ?? "Could not start recording.");
    }
  };

  const onMicPressOut = async () => {
    const startedAt = voiceStartedAt.current;
    voiceStartedAt.current = null;
    const result = await voice.stop();
    if (!result) {
      if (voice.tooShort) setVoiceError(t("Keep the mic pressed to record."));
      return;
    }
    if (!task) return;
    setVoiceBusy(true);
    try {
      // Two-step: transcribe the audio, then send the transcript to
      // the task-updater agent which diffs it against the current task
      // and returns only the fields that should change.
      const { transcript } = await transcribeAudio(result.uri, result.mimeType);
      const trimmed = (transcript ?? "").trim();
      if (!trimmed) {
        setVoiceError("Couldn't hear that. Try again.");
        return;
      }
      const { patch, reply } = await voiceUpdateTask(task.id, trimmed);
      if (!patch || Object.keys(patch).length === 0) {
        setVoiceError(reply || "Nothing to change from that instruction.");
        return;
      }
      // Merge the patch into the edit-mode state. Only touch fields the
      // LLM actually returned — leave the rest as the user had them.
      if (typeof patch.title === "string") setEditTitle(patch.title);
      if (patch.label !== undefined) setEditLabel(patch.label ?? "");
      if (patch.description !== undefined) {
        setEditDescription(patch.description ?? "");
      }
      if (patch.due_at !== undefined) {
        setEditDueAt(patch.due_at ? new Date(patch.due_at) : null);
      }
      // Importance isn't currently editable in the form UI — patch is
      // applied directly via PATCH later. We ignore it locally so the
      // form's importance display matches the about-to-be-saved value.
      setVoiceError(reply ? `${reply} Review and Save.` : "Review and Save.");
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      setVoiceError(msg);
    } finally {
      setVoiceBusy(false);
    }
  };

  const confirmDelete = async () => {
    setError(null);
    setBusy("delete");
    try {
      await deleteTask(task.id);
      await dismissDeliveredFor(task.id);
      removeTask(task.id);
      router.back();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(null);
    }
  };

  // Two-tap delete: bin icon opens a native Alert, the user must
  // explicitly confirm "Yes, delete" before we hit the API.
  const onDelete = () => {
    if (busy) return;
    Alert.alert(translate("Are you sure you want to delete this task?"), translate("This will remove the task from your universe."),
      [
        { text: translate("Cancel"), style: "cancel" },
        { text: translate("Yes, delete"), style: "destructive", onPress: confirmDelete },
      ],
    );
  };

  const importanceLabel = IMPORTANCE_LABELS[task.importance] ?? "Normal";
  const dueText = task.due_at ? new Date(task.due_at).toLocaleString() : "No due date";
  const realClusters = clusters.filter((c) => c.id !== SYNTHETIC_DRIFT_ID);

  return (
    // Full-screen modal — SafeAreaView handles status bar and home
    // indicator inset; KeyboardAvoidingView lifts content out from
    // under the keyboard in edit mode.
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        <ScreenHeader
          title={t("Task")}
          backIcon="close"
          action={
            mode === "view"
              ? {
                  icon: "delete-outline",
                  onPress: onDelete,
                  label: "Delete task",
                  tint: colors.overdue,
                  busy: busy === "delete",
                  disabled: busy !== null,
                }
              : undefined
          }
        />

        <ScrollView
          keyboardDismissMode="on-drag"
          style={styles.flex}
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
        >
          {mode === "view" ? (
            <>
              <Text style={styles.title}>{task.title}</Text>

              {task.label ? (
                <View style={styles.labelPillRow}>
                  <Text style={styles.labelPill}>{task.label}</Text>
                </View>
              ) : null}

              {/* Where the vote stands, shown only once somebody else is on
                  this. "1 of 2 — waiting on them" is the whole point: the
                  user needs to know their tap registered AND that the task
                  is not finished, and a silent screen says neither. */}
              {sharing && sharing.participants > 1 ? (
                <View style={styles.sharedBox}>
                  <View style={styles.sharedHead}>
                    <MaterialIcons name="group" size={16} color={colors.accent} />
                    <Text style={styles.sharedTitle}>
                      {t("Shared with {n} others", {
                        n: String(sharing.participants - 1),
                      })}
                    </Text>
                  </View>
                  <Text style={styles.sharedState}>
                    {sharing.votes === 0
                      ? t("Nobody has marked it done yet.")
                      : t("{votes} of {needed} agree it's done.", {
                          votes: String(sharing.votes),
                          needed: String(sharing.needed),
                        })}
                  </Text>
                  {iSaidDone ? (
                    <View style={styles.sharedYou}>
                      <MaterialIcons
                        name="check-circle"
                        size={14}
                        color={colors.health}
                      />
                      <Text style={styles.sharedYouText}>
                        {t("You've said it's done — waiting on the others.")}
                      </Text>
                    </View>
                  ) : null}
                </View>
              ) : null}

              <View style={styles.metaCell}>
                <Text style={styles.metaLabel}>{t("Description")}</Text>
                <Text style={[styles.metaValue, !task.description && styles.metaPlaceholder]}>
                  {task.description ?? "Tap Edit to add notes about this task."}
                </Text>
              </View>

              <View style={styles.metaRow}>
                <View style={styles.metaCell}>
                  <Text style={styles.metaLabel}>{t("Cluster")}</Text>
                  <View style={styles.metaValueRow}>
                    {currentCluster ? (
                      <View style={[styles.clusterDot, { backgroundColor: currentCluster.color }]} />
                    ) : null}
                    <Text style={styles.metaValue}>{currentCluster?.name ?? "No cluster"}</Text>
                  </View>
                </View>
                <View style={styles.metaCell}>
                  <Text style={styles.metaLabel}>{t("Importance")}</Text>
                  <Text style={styles.metaValue}>{task.importance} / 10 · {importanceLabel}</Text>
                </View>
              </View>

              <View style={styles.metaCell}>
                <Text style={styles.metaLabel}>{t("Due")}</Text>
                <Text style={styles.metaValue}>{dueText}</Text>
              </View>

              <View style={styles.metaCell}>
                <Text style={styles.metaLabel}>{t("Pressure")}</Text>
                <Text style={styles.metaValue}>{task.pressure_score.toFixed(1)} / 10</Text>
              </View>
            </>
          ) : (
            <>
              <Text style={styles.metaLabel}>{t("Title")}</Text>
              <TextInput
                value={editTitle}
                onChangeText={setEditTitle}
                multiline
                style={styles.editTitleInput}
                placeholderTextColor={colors.inkDim}
              />

              <Text style={styles.metaLabel}>{t("Bubble label")}</Text>
              <TextInput
                value={editLabel}
                onChangeText={setEditLabel}
                placeholder={t("Short keyword shown in the bubble")}
                placeholderTextColor={colors.inkDim}
                maxLength={28}
                style={styles.editLabelInput}
              
            returnKeyType="done"
            onSubmitEditing={() => Keyboard.dismiss()}
          />

              <Text style={styles.metaLabel}>{t("Description")}</Text>
              <TextInput
                value={editDescription}
                onChangeText={setEditDescription}
                multiline
                placeholder={t("Add notes — context, why it matters, who's involved…")}
                placeholderTextColor={colors.inkDim}
                style={styles.editDescriptionInput}
              />

              <Text style={styles.metaLabel}>{t("Cluster")}</Text>
              <ScrollView
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipRow}
              >
                <ClusterChip
                  label={t("No cluster")}
                  selected={editClusterId === null}
                  color={colors.drift}
                  onPress={() => setEditClusterId(null)}
                />
                {realClusters.map((c) => (
                  <ClusterChip
                    key={c.id}
                    label={c.name}
                    selected={editClusterId === c.id}
                    color={c.color}
                    onPress={() => setEditClusterId(c.id)}
                  />
                ))}
              </ScrollView>

              <Text style={styles.metaLabel}>{t("Due")}</Text>
              <View style={styles.dueRow}>
                {Platform.OS === "ios" ? (
                  // Compact mode renders as an inline button that opens
                  // its own native modal on tap. Avoids the spinner
                  // eating half the sheet and the Done/Save button
                  // collision the user reported.
                  <DateTimePicker
                    value={editDueAt ?? new Date()}
                    mode="datetime"
                    display="compact"
                    themeVariant="dark"
                    onChange={(_event, date) => {
                      if (date) setEditDueAt(date);
                    }}
                  />
                ) : (
                  <Pressable onPress={() => setShowDatePicker(true)} style={styles.dueButton}>
                    <Text style={styles.dueText}>
                      {editDueAt ? editDueAt.toLocaleString() : "No due date"}
                    </Text>
                  </Pressable>
                )}
                {editDueAt ? (
                  <Pressable onPress={() => setEditDueAt(null)} hitSlop={8} style={styles.clearDue}>
                    <Text style={styles.clearDueText}>{t("Clear")}</Text>
                  </Pressable>
                ) : null}
              </View>

              {Platform.OS !== "ios" && showDatePicker ? (
                <DateTimePicker
                  value={editDueAt ?? new Date()}
                  mode="datetime"
                  display="default"
                  onChange={(event, date) => {
                    setShowDatePicker(false);
                    if (event.type === "set" && date) setEditDueAt(date);
                  }}
                />
              ) : null}
            </>
          )}

          {error ? <Text style={styles.error}>{error}</Text> : null}
          {voiceError ? <Text style={styles.error}>{voiceError}</Text> : null}
        </ScrollView>

        {/* Edit-mode mic — sits in its OWN row above the footer's
            top border so it floats just above the "Cancel | Save"
            divider line. Used to live inside the footer; the new
            position is closer to what Lucas asked for. */}
        {mode === "edit" ? (
          <View style={styles.micRow}>
            <Pressable
              onPressIn={onMicPressIn}
              onPressOut={onMicPressOut}
              disabled={voiceBusy}
              hitSlop={8}
              style={[
                styles.micCircle,
                voice.isRecording && styles.micCircleActive,
                voiceBusy && styles.micButtonBusy,
              ]}
              accessibilityLabel="Hold to dictate task update"
            >
              {voiceBusy ? (
                <ActivityIndicator color={colors.ink} />
              ) : (
                <Text style={styles.micText}>🎙</Text>
              )}
            </Pressable>
          </View>
        ) : null}

        <View style={styles.footer}>
          {mode === "view" ? (
            <>
              <Pressable
                onPress={enterEdit}
                disabled={busy !== null}
                style={[styles.editBtn, busy && styles.btnDisabled]}
                accessibilityLabel="Edit task"
              >
                <Text style={styles.editBtnText}>{t("Edit")}</Text>
              </Pressable>
              {/* Only the owner can invite. A participant adding more people
                  to somebody else's task would change how many votes that
                  person needs to finish their own errand. */}
              {!task.shared_with_me ? (
                <Pressable
                  onPress={() => setShareOpen(true)}
                  disabled={busy !== null}
                  style={[styles.editBtn, busy && styles.btnDisabled]}
                  accessibilityLabel="Share this task"
                >
                  <MaterialIcons name="person-add" size={20} color={colors.ink} />
                </Pressable>
              ) : null}
              {isCompleted ? (
                <Pressable
                  onPress={onReopen}
                  disabled={busy !== null}
                  style={[styles.holdBtn, busy && styles.btnDisabled]}
                >
                  {busy === "complete" ? (
                    <ActivityIndicator color="white" />
                  ) : (
                    <Text style={styles.holdBtnText}>{t("Reopen task")}</Text>
                  )}
                </Pressable>
              ) : (
                <Pressable
                  onPressIn={onHoldStart}
                  onPressOut={onHoldEnd}
                  disabled={busy !== null}
                  style={[styles.holdBtn, busy && styles.btnDisabled]}
                  accessibilityLabel="Hold for 2 seconds to mark complete"
                >
                  {/* Fill bar that animates left-to-right as the user
                      holds. Sits behind the label text so the label
                      stays readable throughout. */}
                  <Animated.View style={[styles.holdBtnFill, holdFillStyle]} />
                  {busy === "complete" ? (
                    <ActivityIndicator color="white" />
                  ) : (
                    <Text style={styles.holdBtnText}>{t("Hold to mark complete")}</Text>
                  )}
                </Pressable>
              )}
            </>
          ) : (
            <>
              <Pressable
                onPress={cancelEdit}
                disabled={busy !== null}
                style={[styles.cancelBtn, busy && styles.btnDisabled]}
              >
                <Text style={styles.cancelBtnText}>{t("Cancel")}</Text>
              </Pressable>
              <Pressable
                onPress={onSave}
                disabled={busy !== null}
                style={[styles.primaryBtn, busy && styles.btnDisabled]}
              >
                {busy === "save" ? (
                  <ActivityIndicator color="white" />
                ) : (
                  <Text style={styles.primaryBtnText}>{t("Save changes")}</Text>
                )}
              </Pressable>
            </>
          )}
        </View>
        <ShareTaskSheet
          visible={shareOpen}
          taskId={task.id}
          taskTitle={task.label || task.title}
          sharing={sharing}
          onClose={() => setShareOpen(false)}
          onShared={refreshSharing}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

interface ChipProps {
  label: string;
  selected: boolean;
  color: string;
  onPress: () => void;
}

function ClusterChip({ label, selected, color, onPress }: ChipProps) {
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.chip,
        { borderColor: color },
        selected && { backgroundColor: color },
      ]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  flex: { flex: 1 },
  micButton: { justifyContent: "center", alignItems: "center", minHeight: 28 },
  micButtonActive: { transform: [{ scale: 1.15 }] },
  micButtonBusy: { opacity: 0.6 },
  micText: { fontSize: 20 },
  body: { paddingHorizontal: 24, paddingTop: 18, paddingBottom: 24 },
  title: { color: colors.ink, fontSize: 22, fontWeight: "700", marginBottom: 8 },
  description: { color: colors.inkDim, fontSize: 14, marginBottom: 14, lineHeight: 20 },
  metaPlaceholder: { color: colors.inkDim, fontStyle: "italic", fontWeight: "400" },
  labelPillRow: { flexDirection: "row", marginBottom: 16 },
  labelPill: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: "600",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    overflow: "hidden",
  },
  metaRow: {
    flexDirection: "row",
    gap: 16,
    marginTop: 8,
    marginBottom: 14,
  },
  metaCell: { flex: 1, marginBottom: 14 },
  metaLabel: {
    color: colors.inkDim,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  metaValueRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  metaValue: { color: colors.ink, fontSize: 14, fontWeight: "500" },
  clusterDot: { width: 10, height: 10, borderRadius: 5 },
  // Edit-mode controls
  editTitleInput: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: "600",
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 14,
  },
  editLabelInput: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: "500",
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 14,
  },
  editDescriptionInput: {
    color: colors.ink,
    fontSize: 14,
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 14,
    minHeight: 80,
    textAlignVertical: "top",
  },
  chipRow: { gap: 8, paddingBottom: 14 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipText: { color: colors.ink, fontSize: 13, fontWeight: "500" },
  chipTextSelected: { color: "white", fontWeight: "700" },
  dueRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 16 },
  dueButton: {
    flex: 1,
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  dueText: { color: colors.ink, fontSize: 14 },
  clearDue: { paddingHorizontal: 6 },
  clearDueText: { color: colors.inkDim, fontSize: 13 },
  doneRow: { alignSelf: "flex-end", paddingVertical: 8, paddingHorizontal: 12 },
  doneText: { color: colors.accent, fontSize: 14, fontWeight: "600" },
  error: { color: colors.overdue, fontSize: 13, marginTop: 12 },
  centered: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  secondary: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    marginTop: 16,
    borderRadius: 999,
    borderColor: colors.line,
    borderWidth: 1,
  },
  secondaryText: { color: colors.ink, fontSize: 13, fontWeight: "600" },
  footer: {
    // Regular last child of the flex column. SafeAreaView handles
    // the home indicator inset at the bottom, KeyboardAvoidingView
    // lifts this above the keyboard in edit mode. ScrollView above
    // has flex:1 so this footer naturally pins to the bottom.
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderTopColor: colors.line,
    borderTopWidth: 1,
    backgroundColor: colors.canvas,
  },
  // Mic sits in the body flow above the footer's top border line,
  // not inside the footer itself. Some bottom padding gives it
  // breathing room above the divider.
  micRow: {
    alignItems: "center",
    paddingBottom: 12,
  },
  micCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderColor: colors.line,
    borderWidth: 1.5,
    backgroundColor: colors.panel,
    alignItems: "center",
    justifyContent: "center",
  },
  micCircleActive: {
    borderColor: colors.overdue,
    backgroundColor: "rgba(190, 18, 60, 0.10)",
  },
  primaryBtn: {
    flex: 2,
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryBtnText: { color: "white", fontSize: 15, fontWeight: "700" },
  // Hold-to-complete button. Fill bar animates as the user holds.
  holdBtn: {
    flex: 1,
    backgroundColor: colors.panel,
    borderColor: colors.accent,
    borderWidth: 1.5,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  holdBtnFill: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: colors.accent,
  },
  // textAlign matters because this label wraps. The button centres the
  // Text box, but the LINES inside it default to left — so a two-line
  // label renders ragged against the left edge and reads as broken.
  // Same bug that was fixed in action-bar.tsx for "Organizar o resto".
  holdBtnText: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: "700",
    textAlign: "center",
  },
  // Delete bin — small circular button, accent of overdue color.
  sharedBox: {
    marginTop: 14,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
  },
  sharedHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  sharedTitle: { color: colors.ink, fontSize: 13, fontWeight: "700" },
  sharedState: { color: colors.inkDim, fontSize: 12.5, marginTop: 6, lineHeight: 18 },
  sharedYou: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
  sharedYouText: { color: colors.health, fontSize: 11.5, fontWeight: "600", flex: 1 },
  editBtn: {
    height: 52,
    paddingHorizontal: 20,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
    alignItems: "center",
    justifyContent: "center",
  },
  editBtnText: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  deleteIconBtn: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: "transparent",
    borderColor: colors.overdue,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelBtn: {
    flex: 1,
    backgroundColor: "transparent",
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  cancelBtnText: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  btnDisabled: { opacity: 0.5 },
});
