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

import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
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
import { ApiError, createTask } from "@/services/api";
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

  const current: ParsedTask | undefined = queue[index];

  // Re-seed the editable fields every time the queue advances. Without
  // this the second task would inherit the first task's edited label.
  useEffect(() => {
    if (!current) return;
    setLabelDraft(
      current.label && current.label.trim().length > 0
        ? current.label.trim()
        : deriveLabel(current.title),
    );
    setDescriptionDraft(
      current.description && current.description.trim().length > 0
        ? current.description.trim()
        : "",
    );
    setError(null);
  }, [current]);

  const advance = useCallback(() => {
    if (index + 1 < queue.length) {
      setIndex((i) => i + 1);
    } else {
      router.back();
    }
  }, [index, queue.length, router]);

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
            <Text style={styles.headerCancel}>{addedCount > 0 ? t("Done") : t("Cancel")}</Text>
          </Pressable>
          <Text style={styles.headerTitle}>
            {isQueue
              ? t("Task {n} of {total}", { n: index + 1, total: queue.length })
              : t("Confirm task")}
          </Text>
          <View style={{ width: 50 }} />
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

        <ScrollView style={styles.flex} contentContainerStyle={styles.body}>
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

          {current.due_at ? (
            <>
              <Text style={styles.label}>{t("Due")}</Text>
              <Text style={styles.parsedValue}>
                {new Date(current.due_at).toLocaleString()}
              </Text>
            </>
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
  headerCancel: { color: colors.inkDim, fontSize: 14, width: 50 },
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
