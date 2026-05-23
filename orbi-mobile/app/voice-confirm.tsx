// Voice capture confirmation modal.
//
// Receives the chat-agent's parsed task structure plus the original
// transcript as a JSON-stringified search param. Renders the parsed
// fields for the user to confirm, then POSTs to /api/v1/tasks and
// prepends the result into the universe store.

import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ApiError, createTask } from "@/services/api";
import { useUniverseStore } from "@/stores/universeStore";
import { colors } from "@/theme/colors";

interface ParsedPayload {
  title: string;
  due_at?: string | null;
  parent_cluster_id?: string | null;
  importance?: number;
  confidence?: number;
  transcript: string;
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

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onConfirm = async () => {
    if (!parsed) return;
    setError(null);
    setSubmitting(true);
    try {
      const created = await createTask({
        title: parsed.title,
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
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.headerCancel}>Cancel</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Confirm task</Text>
        <View style={{ width: 50 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.label}>You said</Text>
        <Text style={styles.transcript}>"{parsed.transcript}"</Text>

        <Text style={styles.label}>Parsed title</Text>
        <Text style={styles.parsedTitle}>{parsed.title}</Text>

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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
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
