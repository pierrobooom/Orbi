// Confirmation for a voice command against an EXISTING task.
//
// "mark the gym one as done", "delete the website task", "push the rent
// to Friday" all land here. The server has already worked out which task
// was meant, but has deliberately changed nothing — a misheard
// transcript must never be able to complete or destroy a task on its
// own. This screen is where the user says yes.
//
// When the match was ambiguous (two plausible tasks), the alternatives
// are listed so the user can pick the other one instead of cancelling
// and repeating themselves.

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
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { SafeAreaView } from "react-native-safe-area-context";

import { useT } from "@/i18n";
import { ApiError, deleteTask, updateTask } from "@/services/api";
import { useUniverseStore } from "@/stores/universeStore";
import { colors } from "@/theme/colors";

type VoiceAction = "complete" | "delete" | "update";

interface ActionTask {
  id: string;
  title: string;
  label?: string | null;
  due_at?: string | null;
  importance?: number | null;
}

interface ActionPayload {
  action: VoiceAction;
  transcript: string;
  task: ActionTask;
  ambiguous?: boolean;
  alternatives?: { id: string; title: string }[];
  patch?: Record<string, unknown>;
}

const ACTION_VERB: Record<VoiceAction, string> = {
  complete: "Mark as done",
  delete: "Delete",
  update: "Apply change",
};

export default function VoiceActionScreen() {
  const t = useT();
  const router = useRouter();
  const { payload } = useLocalSearchParams<{ payload: string }>();
  const replaceTask = useUniverseStore((s) => s.replaceTask);
  const removeTask = useUniverseStore((s) => s.removeTask);
  const getServerTask = useUniverseStore((s) => s.getServerTask);

  const parsed: ActionPayload | null = useMemo(() => {
    const raw = Array.isArray(payload) ? payload[0] : payload;
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ActionPayload;
    } catch {
      return null;
    }
  }, [payload]);

  const [targetId, setTargetId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeId = targetId ?? parsed?.task.id ?? null;
  const activeTitle =
    activeId && activeId !== parsed?.task.id
      ? getServerTask(activeId)?.title ?? ""
      : parsed?.task.title ?? "";

  const confirm = async () => {
    if (!parsed || !activeId || busy) return;
    setError(null);
    setBusy(true);
    try {
      if (parsed.action === "delete") {
        await deleteTask(activeId);
        removeTask(activeId);
      } else if (parsed.action === "complete") {
        const updated = await updateTask(activeId, { status: "completed" });
        replaceTask(updated);
      } else {
        const patch = parsed.patch ?? {};
        if (Object.keys(patch).length === 0) {
          setError(t("Nothing to change."));
          setBusy(false);
          return;
        }
        const updated = await updateTask(activeId, patch);
        replaceTask(updated);
      }
      router.back();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  };

  if (!parsed) {
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

  const destructive = parsed.action === "delete";
  const patchEntries = Object.entries(parsed.patch ?? {});

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.headerCancel} numberOfLines={1}>{t("Cancel")}</Text>
        </Pressable>
        <Text style={styles.headerTitle}>{t("Confirm")}</Text>
        <View style={{ minWidth: 64 }} />
      </View>

      <ScrollView
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.body}
      >
        <Text style={styles.label}>{t("You said")}</Text>
        <Text style={styles.transcript}>&quot;{parsed.transcript}&quot;</Text>

        <Text style={styles.label}>{t("Task")}</Text>
        <Text style={styles.taskTitle}>{activeTitle}</Text>

        {parsed.ambiguous ? (
          <View style={styles.warnCard}>
            <MaterialIcons name="help-outline" size={16} color={colors.overdue} />
            <Text style={styles.warnText}>
              {t("More than one task matches. Check this is the right one.")}
            </Text>
          </View>
        ) : null}

        {patchEntries.length > 0 ? (
          <>
            <Text style={styles.label}>{t("Change")}</Text>
            {patchEntries.map(([key, value]) => (
              <Text key={key} style={styles.patchLine}>
                {key}: {formatPatchValue(value)}
              </Text>
            ))}
          </>
        ) : null}

        {parsed.alternatives && parsed.alternatives.length > 0 ? (
          <>
            <Text style={styles.label}>{t("Or did you mean")}</Text>
            {parsed.alternatives.map((alt) => {
              const selected = activeId === alt.id;
              return (
                <Pressable
                  key={alt.id}
                  onPress={() => setTargetId(alt.id)}
                  style={[styles.altRow, selected && styles.altRowActive]}
                >
                  <Text style={styles.altText}>{alt.title}</Text>
                  {selected ? (
                    <MaterialIcons name="check" size={16} color={colors.accent} />
                  ) : null}
                </Pressable>
              );
            })}
          </>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          onPress={confirm}
          disabled={busy}
          style={[
            styles.primary,
            destructive && styles.primaryDestructive,
            busy && styles.primaryDisabled,
          ]}
        >
          {busy ? (
            <ActivityIndicator color="white" />
          ) : (
            <Text style={styles.primaryText}>{t(ACTION_VERB[parsed.action])}</Text>
          )}
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

function formatPatchValue(value: unknown): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return new Date(value).toLocaleString();
  }
  return String(value);
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
  headerCancel: { color: colors.inkDim, fontSize: 14, minWidth: 64 },
  body: { padding: 24 },
  label: {
    color: colors.inkDim,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 6,
    marginTop: 18,
  },
  transcript: { color: colors.ink, fontSize: 15, fontStyle: "italic", lineHeight: 21 },
  taskTitle: { color: colors.ink, fontSize: 20, fontWeight: "700" },
  patchLine: { color: colors.ink, fontSize: 14, marginBottom: 2 },
  warnCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 16,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.overdue,
  },
  warnText: { color: colors.ink, fontSize: 12, flex: 1, lineHeight: 17 },
  altRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    marginBottom: 8,
  },
  altRowActive: { borderColor: colors.accent, backgroundColor: colors.panel },
  altText: { color: colors.ink, fontSize: 14, flex: 1 },
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
  primaryDestructive: { backgroundColor: colors.overdue },
  primaryDisabled: { opacity: 0.5 },
  primaryText: { color: "white", fontSize: 15, fontWeight: "700" },
});
