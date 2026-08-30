// Voice capture confirmation.
//
// One utterance can produce several tasks ("book the dentist, call mum,
// buy milk"), so this screen is a QUEUE, not a single form: it walks the
// parsed tasks one at a time and each is independently added or skipped.
// With a single task it looks and behaves exactly as it did before —
// the stepper chrome only appears when there's more than one.
//
// Tasks are created as you go rather than batched at the end. If the
// user bails halfway, what they already confirmed is safely saved, and
// nothing they haven't seen gets written.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import DateTimePicker from "@react-native-community/datetimepicker";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
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

import { useT } from "@/i18n";
import {
  ApiError,
  createTask,
  draftVoiceUpdate,
  transcribeAudio,
} from "@/services/api";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { useUniverseStore } from "@/stores/universeStore";
import { colors } from "@/theme/colors";

interface ParsedTask {
  title: string;
  label?: string | null;
  description?: string | null;
  due_at?: string | null;
  parent_cluster_id?: string | null;
  importance?: number;
  confidence?: number;
}

interface ParsedPayload {
  tasks?: ParsedTask[];
  transcript: string;
  // Legacy single-task shape (pre multi-task). Kept so an in-flight
  // navigation from an older bundle still renders.
  title?: string;
  label?: string | null;
  description?: string | null;
  due_at?: string | null;
  parent_cluster_id?: string | null;
  importance?: number;
  confidence?: number;
}

// Mirror of services/universeLayout deriveLabel — used only when the
// LLM didn't return a label, so the user still sees something sensible
// in the editable field on the confirm screen.
const STOP_WORDS = new Set([
  "a", "an", "the", "to", "from", "about", "of", "for", "with",
  "and", "or", "in", "on", "at", "by", "as", "is", "was", "are",
  "be", "been", "this", "that", "these", "those", "my", "your",
  "i", "im", "i'm", "ive", "i've",
]);
const LOW_SIGNAL_VERBS = new Set([
  "call", "buy", "go", "send", "email", "remind", "make", "do",
  "get", "have", "take", "pick", "drop", "visit", "see", "check",
  "need", "want", "should", "must", "gotta", "going", "gonna",
]);

function deriveLabel(title: string, maxChars = 14): string {
  const trimmed = (title ?? "").trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxChars) return trimmed;
  const words = trimmed.split(/\s+/);
  const content = words.filter((w) => {
    const lower = w.toLowerCase().replace(/[^a-z0-9']/g, "");
    if (!lower) return false;
    if (STOP_WORDS.has(lower)) return false;
    if (LOW_SIGNAL_VERBS.has(lower)) return false;
    return true;
  });
  const pickFrom = content.length > 0 ? content : words;
  let out = "";
  for (const w of pickFrom) {
    const candidate = out ? `${out} ${w}` : w;
    if (candidate.length > maxChars) break;
    out = candidate;
  }
  if (!out) out = trimmed.slice(0, maxChars);
  return out;
}

export default function VoiceConfirmScreen() {
  const t = useT();
  const router = useRouter();
  const { payload } = useLocalSearchParams<{ payload: string }>();
  const addTask = useUniverseStore((s) => s.addTask);

  // useLocalSearchParams is typed as string | string[] — collapse arrays
  // (shouldn't happen in our usage but TS wants the guard) and JSON
  // parse. If the payload is malformed, fall back to null so the screen
  // renders an error instead of crashing.
  const payloadObject: ParsedPayload | null = useMemo(() => {
    const raw = Array.isArray(payload) ? payload[0] : payload;
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ParsedPayload;
    } catch {
      return null;
    }
  }, [payload]);

  const queue: ParsedTask[] = useMemo(() => {
    if (!payloadObject) return [];
    if (Array.isArray(payloadObject.tasks)) {
      return payloadObject.tasks.filter((t) => t && t.title);
    }
    if (payloadObject.title) {
      return [payloadObject as ParsedTask];
    }
    return [];
  }, [payloadObject]);

  const [index, setIndex] = useState(0);
  const [labelDraft, setLabelDraft] = useState("");
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addedCount, setAddedCount] = useState(0);

  // Per-task edits made on this screen. Kept keyed by queue index rather
  // than mutating `queue` (which is derived from the route param via
  // useMemo, so writing to it would be lost on any re-render).
  const [edits, setEdits] = useState<Record<number, Partial<ParsedTask>>>({});
  const [showPicker, setShowPicker] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceReply, setVoiceReply] = useState<string | null>(null);
  const voice = useVoiceRecorder();

  const base: ParsedTask | undefined = queue[index];
  // The task as it stands now: what the parser produced, plus anything
  // the user has since changed by voice or with the date picker.
  const current: ParsedTask | undefined = base
    ? { ...base, ...(edits[index] ?? {}) }
    : undefined;

  const applyEdit = useCallback(
    (patch: Partial<ParsedTask>) => {
      setEdits((prev) => ({ ...prev, [index]: { ...(prev[index] ?? {}), ...patch } }));
    },
    [index],
  );

  // Re-seed the editable fields every time the queue advances. Without
  // this the second task would inherit the first task's edited label.
  // Keyed on `index`, not on `current` — `current` is a fresh object on
  // every edit, which would re-seed (and so discard) the user's typing
  // the instant a voice edit landed.
  useEffect(() => {
    const task = queue[index];
    if (!task) return;
    setLabelDraft(
      task.label && task.label.trim().length > 0
        ? task.label.trim()
        : deriveLabel(task.title),
    );
    setDescriptionDraft(
      task.description && task.description.trim().length > 0
        ? task.description.trim()
        : "",
    );
    setError(null);
    setVoiceReply(null);
    setShowPicker(false);
  }, [index, queue]);

  // A voice edit can rewrite the label or description the user is
  // looking at, so mirror those into the inputs when they change.
  const editedLabel = edits[index]?.label;
  const editedDescription = edits[index]?.description;
  useEffect(() => {
    if (typeof editedLabel === "string") setLabelDraft(editedLabel);
  }, [editedLabel]);
  useEffect(() => {
    if (typeof editedDescription === "string") setDescriptionDraft(editedDescription);
  }, [editedDescription]);

  const advance = useCallback(() => {
    if (index + 1 < queue.length) {
      setIndex((i) => i + 1);
    } else {
      router.back();
    }
  }, [index, queue.length, router]);

  const onMicPressIn = async () => {
    setVoiceReply(null);
    setError(null);
    const ok = await voice.start();
    if (!ok) setError(voice.permissionError ?? t("Could not start recording."));
  };

  // Hold-to-talk correction: "make it Tuesday at 9", "call it MOT
  // booking". Same agent the saved-task voice edit uses, so behaviour is
  // identical either side of saving — it just works on the draft, since
  // there's no id to address before the task exists.
  const onMicPressOut = async () => {
    const result = await voice.stop();
    if (!result || !current) {
      if (voice.tooShort) setError(t("Keep the mic pressed to record."));
      return;
    }
    setVoiceBusy(true);
    try {
      const { transcript } = await transcribeAudio(result.uri, result.mimeType);
      if (!transcript || transcript.trim().length === 0) {
        setError(t("Couldn't hear that. Try again."));
        return;
      }
      const { patch, reply } = await draftVoiceUpdate(
        {
          title: current.title,
          label: labelDraft.trim() || null,
          description: descriptionDraft.trim() || null,
          due_at: current.due_at ?? null,
          importance: current.importance ?? null,
        },
        transcript,
      );
      if (patch && Object.keys(patch).length > 0) {
        applyEdit(patch as Partial<ParsedTask>);
      }
      setVoiceReply(reply || null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setVoiceBusy(false);
    }
  };

  const onConfirm = async () => {
    if (!current) return;
    setError(null);
    setSubmitting(true);
    try {
      const trimmedLabel = labelDraft.trim();
      const trimmedDescription = descriptionDraft.trim();
      const created = await createTask({
        title: current.title,
        label: trimmedLabel.length > 0 ? trimmedLabel : null,
        description: trimmedDescription.length > 0 ? trimmedDescription : null,
        parent_cluster_id: current.parent_cluster_id ?? null,
        due_at: current.due_at ?? null,
        importance: current.importance,
      });
      addTask(created);
      setAddedCount((n) => n + 1);
      setSubmitting(false);
      advance();
    } catch (e) {
      // Stay on this task so the user can retry — advancing would lose
      // whatever they typed and silently drop the task.
      const msg = e instanceof ApiError ? e.message : String(e);
      setError(msg);
      setSubmitting(false);
    }
  };

  if (!payloadObject || queue.length === 0 || !current) {
    return (
      <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
        <View style={styles.centered}>
          <Text style={styles.errorTitle}>{t("Could not read voice payload")}</Text>
          <Pressable onPress={() => router.back()} style={styles.secondary}>
            <Text style={styles.secondaryText}>{t("Close")}</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const isQueue = queue.length > 1;
  const confidencePct =
    current.confidence != null ? Math.round(current.confidence * 100) : null;

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Text style={styles.headerCancel} numberOfLines={1}>{addedCount > 0 ? t("Done") : t("Cancel")}</Text>
          </Pressable>
          <Text style={styles.headerTitle}>
            {isQueue
              ? t("Task {n} of {total}", { n: index + 1, total: queue.length })
              : t("Confirm task")}
          </Text>
          <View style={{ minWidth: 64 }} />
        </View>

        {isQueue ? (
          <View style={styles.progressRow}>
            {queue.map((t, i) => (
              <View
                key={`${t.title}-${i}`}
                style={[
                  styles.progressDot,
                  i === index && styles.progressDotActive,
                  i < index && styles.progressDotDone,
                ]}
              />
            ))}
          </View>
        ) : null}

        <ScrollView
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled" style={styles.flex} contentContainerStyle={styles.body}>
          <Text style={styles.label}>{t("You said")}</Text>
          <Text style={styles.transcript}>"{payloadObject.transcript}"</Text>

          <Text style={styles.label}>{t("Parsed title")}</Text>
          <Text style={styles.parsedTitle}>{current.title}</Text>

          <Text style={styles.label}>{t("Bubble label")}</Text>
          <TextInput
            value={labelDraft}
            onChangeText={setLabelDraft}
            placeholder={t("Short keyword shown inside the bubble")}
            placeholderTextColor={colors.inkDim}
            maxLength={28}
            style={styles.labelInput}
          
            returnKeyType="done"
            onSubmitEditing={() => Keyboard.dismiss()}
          />
          <Text style={styles.hint}>
            {t("What you'll see in the bubble. Edit it now or keep what we picked.")}
          </Text>

          <Text style={styles.label}>{t("Description")}</Text>
          <TextInput
            value={descriptionDraft}
            onChangeText={setDescriptionDraft}
            placeholder={t("Sub-items, notes, context — empty if none")}
            placeholderTextColor={colors.inkDim}
            maxLength={240}
            multiline
            style={styles.descriptionInput}
          />
          <Text style={styles.hint}>
            {t(
              "We auto-fill this when you mention details like item lists or specifics. Leave blank for simple tasks.",
            )}
          </Text>

          {/* Editable, and always shown. Previously this row only
              appeared when the parser found a date, so the most common
              case — no date mentioned — offered no way to add one
              without saving first and reopening the task. */}
          <Text style={styles.label}>{t("Due")}</Text>
          <View style={styles.dueRow}>
            <Pressable onPress={() => setShowPicker(true)} style={styles.dueButton}>
              <Text style={styles.dueText}>
                {current.due_at
                  ? new Date(current.due_at).toLocaleString()
                  : t("No due date")}
              </Text>
            </Pressable>
            {current.due_at ? (
              <Pressable
                onPress={() => applyEdit({ due_at: null })}
                hitSlop={8}
                style={styles.clearDue}
              >
                <Text style={styles.clearDueText}>{t("Clear")}</Text>
              </Pressable>
            ) : null}
          </View>

          {showPicker ? (
            <DateTimePicker
              value={current.due_at ? new Date(current.due_at) : new Date()}
              mode="datetime"
              display={Platform.OS === "ios" ? "spinner" : "default"}
              themeVariant="dark"
              onChange={(event, date) => {
                if (Platform.OS === "android") setShowPicker(false);
                if (event.type === "set" && date) {
                  applyEdit({ due_at: date.toISOString() });
                }
                if (event.type === "dismissed") setShowPicker(false);
              }}
            />
          ) : null}

          {Platform.OS === "ios" && showPicker ? (
            <Pressable onPress={() => setShowPicker(false)} style={styles.doneRow}>
              <Text style={styles.doneText}>{t("Done")}</Text>
            </Pressable>
          ) : null}

          {current.importance != null ? (
            <>
              <Text style={styles.label}>{t("Importance")}</Text>
              <Text style={styles.parsedValue}>{current.importance} / 10</Text>
            </>
          ) : null}

          {confidencePct != null ? (
            <Text style={styles.confidence}>
              {t("Parse confidence: {n}%", { n: confidencePct })}
            </Text>
          ) : null}

          {error ? <Text style={styles.error}>{error}</Text> : null}
        </ScrollView>

        {/* Hold-to-talk correction, above the footer so it reads as
            "adjust this" rather than a primary action. */}
        <View style={styles.micRow}>
          <Pressable
            onPressIn={onMicPressIn}
            onPressOut={onMicPressOut}
            disabled={voiceBusy || submitting}
            style={[
              styles.micButton,
              voice.isRecording && styles.micButtonActive,
              (voiceBusy || submitting) && styles.primaryDisabled,
            ]}
          >
            {voiceBusy ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : (
              <MaterialIcons
                name="mic"
                size={20}
                color={voice.isRecording ? "white" : colors.inkDim}
              />
            )}
          </Pressable>
          <Text style={styles.micHint}>
            {voice.isRecording
              ? t("Listening…")
              : voiceBusy
                ? t("Parsing…")
                : voiceReply
                  ? voiceReply
                  : t("Hold to fix this by voice")}
          </Text>
        </View>

        <View style={styles.footer}>
          {isQueue ? (
            <Pressable
              onPress={advance}
              disabled={submitting}
              style={[styles.skip, submitting && styles.primaryDisabled]}
            >
              <Text style={styles.skipText}>{t("Skip")}</Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={onConfirm}
            disabled={submitting}
            style={[
              styles.primary,
              isQueue && styles.primaryInRow,
              submitting && styles.primaryDisabled,
            ]}
          >
            {submitting ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text style={styles.primaryText}>
                {isQueue && index + 1 < queue.length
                  ? t("Add & next")
                  : t("Add to universe")}
              </Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  flex: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  headerTitle: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  headerCancel: { color: colors.inkDim, fontSize: 14, minWidth: 64 },
  progressRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 6,
    paddingTop: 12,
  },
  progressDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.line,
  },
  progressDotActive: { backgroundColor: colors.accent, width: 18 },
  progressDotDone: { backgroundColor: colors.inkDim },
  body: { padding: 24, paddingBottom: 60 },
  label: {
    color: colors.inkDim,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 6,
    marginTop: 18,
  },
  transcript: { color: colors.ink, fontSize: 16, fontStyle: "italic", lineHeight: 22 },
  parsedTitle: { color: colors.ink, fontSize: 22, fontWeight: "700" },
  parsedValue: { color: colors.ink, fontSize: 15 },
  labelInput: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: "600",
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  descriptionInput: {
    color: colors.ink,
    fontSize: 14,
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minHeight: 70,
    textAlignVertical: "top",
  },
  hint: { color: colors.inkDim, fontSize: 11, marginTop: 6, lineHeight: 15 },
  dueRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  dueButton: {
    flex: 1,
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  dueText: { color: colors.ink, fontSize: 14 },
  clearDue: { paddingHorizontal: 4 },
  clearDueText: { color: colors.inkDim, fontSize: 13, fontWeight: "600" },
  doneRow: { alignItems: "flex-end", paddingTop: 6 },
  doneText: { color: colors.accent, fontSize: 14, fontWeight: "700" },
  micRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 24,
    paddingTop: 12,
    borderTopColor: colors.line,
    borderTopWidth: 1,
  },
  micButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
  },
  micButtonActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  micHint: { color: colors.inkDim, fontSize: 12, flex: 1, lineHeight: 16 },
  confidence: { color: colors.inkDim, fontSize: 12, marginTop: 22 },
  error: { color: colors.overdue, fontSize: 13, marginTop: 16 },
  centered: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  errorTitle: { color: colors.overdue, fontSize: 15, fontWeight: "600", marginBottom: 16 },
  secondary: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    borderColor: colors.line,
    borderWidth: 1,
  },
  secondaryText: { color: colors.ink, fontSize: 13, fontWeight: "600" },
  footer: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 24,
    paddingVertical: 16,
  },
  skip: {
    paddingHorizontal: 22,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
  },
  skipText: { color: colors.inkDim, fontSize: 15, fontWeight: "600" },
  primary: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    flex: 1,
  },
  primaryInRow: { flex: 1 },
  primaryDisabled: { opacity: 0.5 },
  primaryText: { color: "white", fontSize: 15, fontWeight: "700" },
});
