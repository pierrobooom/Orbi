// Voice capture confirmation modal.
//
// Receives the chat-agent's parsed task structure plus the original
// transcript as a JSON-stringified search param. Renders the parsed
// fields for the user to confirm, then POSTs to /api/v1/tasks and
// prepends the result into the universe store.

import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
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

import { ApiError, createTask } from "@/services/api";
import { useUniverseStore } from "@/stores/universeStore";
import { colors } from "@/theme/colors";

interface ParsedPayload {
  title: string;
  label?: string | null;
  description?: string | null;
  due_at?: string | null;
  parent_cluster_id?: string | null;
  importance?: number;
  confidence?: number;
  transcript: string;
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
  const router = useRouter();
  const { payload } = useLocalSearchParams<{ payload: string }>();
  const addTask = useUniverseStore((s) => s.addTask);

  // useLocalSearchParams is typed as string | string[] — collapse arrays
  // (shouldn't happen in our usage but TS wants the guard) and JSON
  // parse. If the payload is malformed, fall back to an empty stub so
  // the screen renders something instead of crashing.
  const parsed: ParsedPayload | null = useMemo(() => {
    const raw = Array.isArray(payload) ? payload[0] : payload;
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ParsedPayload;
    } catch {
      return null;
    }
  }, [payload]);

  const [labelDraft, setLabelDraft] = useState("");
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the label and description inputs from what the LLM gave us.
  // Label falls back to a local derivation off the title; description
  // stays empty if the LLM didn't fill it.
  useEffect(() => {
    if (!parsed) return;
    const initialLabel =
      parsed.label && parsed.label.trim().length > 0
        ? parsed.label.trim()
        : deriveLabel(parsed.title);
    setLabelDraft(initialLabel);
    setDescriptionDraft(
      parsed.description && parsed.description.trim().length > 0
        ? parsed.description.trim()
        : "",
    );
  }, [parsed]);

  const onConfirm = async () => {
    if (!parsed) return;
    setError(null);
    setSubmitting(true);
    try {
      const trimmedLabel = labelDraft.trim();
      const trimmedDescription = descriptionDraft.trim();
      const created = await createTask({
        title: parsed.title,
        label: trimmedLabel.length > 0 ? trimmedLabel : null,
        description: trimmedDescription.length > 0 ? trimmedDescription : null,
        parent_cluster_id: parsed.parent_cluster_id ?? null,
        due_at: parsed.due_at ?? null,
        importance: parsed.importance,
      });
      addTask(created);
      router.back();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      setError(msg);
      setSubmitting(false);
    }
  };

  if (!parsed) {
    return (
      <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
        <View style={styles.centered}>
          <Text style={styles.errorTitle}>Could not read voice payload</Text>
          <Pressable onPress={() => router.back()} style={styles.secondary}>
            <Text style={styles.secondaryText}>Close</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const confidencePct =
    parsed.confidence != null ? Math.round(parsed.confidence * 100) : null;

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Text style={styles.headerCancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.headerTitle}>Confirm task</Text>
          <View style={{ width: 50 }} />
        </View>

        <ScrollView style={styles.flex} contentContainerStyle={styles.body}>
          <Text style={styles.label}>You said</Text>
          <Text style={styles.transcript}>"{parsed.transcript}"</Text>

          <Text style={styles.label}>Parsed title</Text>
          <Text style={styles.parsedTitle}>{parsed.title}</Text>

          <Text style={styles.label}>Bubble label</Text>
          <TextInput
            value={labelDraft}
            onChangeText={setLabelDraft}
            placeholder="Short keyword shown inside the bubble"
            placeholderTextColor={colors.inkDim}
            maxLength={28}
            style={styles.labelInput}
          />
          <Text style={styles.hint}>
            What you'll see in the bubble. Edit it now or keep what we picked.
          </Text>

          <Text style={styles.label}>Description</Text>
          <TextInput
            value={descriptionDraft}
            onChangeText={setDescriptionDraft}
            placeholder="Sub-items, notes, context — empty if none"
            placeholderTextColor={colors.inkDim}
            maxLength={240}
            multiline
            style={styles.descriptionInput}
          />
          <Text style={styles.hint}>
            We auto-fill this when you mention details like item lists or
            specifics. Leave blank for simple tasks.
          </Text>

          {parsed.due_at ? (
            <>
              <Text style={styles.label}>Due</Text>
              <Text style={styles.parsedValue}>
                {new Date(parsed.due_at).toLocaleString()}
              </Text>
            </>
          ) : null}

          {parsed.importance != null ? (
            <>
              <Text style={styles.label}>Importance</Text>
              <Text style={styles.parsedValue}>{parsed.importance} / 10</Text>
            </>
          ) : null}

          {confidencePct != null ? (
            <Text style={styles.confidence}>Parse confidence: {confidencePct}%</Text>
          ) : null}

          {error ? <Text style={styles.error}>{error}</Text> : null}
        </ScrollView>

        <View style={styles.footer}>
          <Pressable
            onPress={onConfirm}
            disabled={submitting}
            style={[styles.primary, submitting && styles.primaryDisabled]}
          >
            {submitting ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text style={styles.primaryText}>Add to universe</Text>
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
  footer: { paddingHorizontal: 24, paddingVertical: 16 },
  primary: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryDisabled: { opacity: 0.5 },
  primaryText: { color: "white", fontSize: 15, fontWeight: "700" },
});
