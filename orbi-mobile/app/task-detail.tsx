// Bubble detail bottom sheet — slides up when the user taps a bubble.
//
// Reads the task by id from universeStore.serverTasks (no network call —
// we already have the full record locally). Shows title, due, importance,
// cluster, and offers two actions:
//   - Mark complete: PATCH /api/v1/tasks/{id} { status: "completed" }
//   - Delete:        DELETE /api/v1/tasks/{id}  (soft-archive on backend)
//
// Both remove the bubble from the active universe via removeTask(); the
// modal then dismisses. Network failure surfaces inline; the local store
// is only mutated after the server confirms so the canvas never lies
// about persisted state.

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

import { ApiError, deleteTask, updateTask } from "@/services/api";
import { useUniverseStore } from "@/stores/universeStore";
import { colors } from "@/theme/colors";

const IMPORTANCE_LABELS: Record<number, string> = {
  10: "Critical", 9: "Critical", 8: "Critical",
  7: "Important", 6: "Important",
  5: "Normal", 4: "Normal",
  3: "Low", 2: "Low", 1: "Low",
};

export default function TaskDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const taskId = Array.isArray(id) ? id[0] : id;

  const getServerTask = useUniverseStore((s) => s.getServerTask);
  const removeTask = useUniverseStore((s) => s.removeTask);
  const clusters = useUniverseStore((s) => s.clusters);

  const task = useMemo(() => (taskId ? getServerTask(taskId) : undefined), [taskId, getServerTask]);
  const cluster = useMemo(
    () => (task?.parent_cluster_id ? clusters.find((c) => c.id === task.parent_cluster_id) : undefined),
    [task, clusters],
  );

  const [busy, setBusy] = useState<"complete" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!task) {
    return (
      <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
        <View style={styles.centered}>
          <Text style={styles.title}>Task not found</Text>
          <Pressable onPress={() => router.back()} style={styles.secondary}>
            <Text style={styles.secondaryText}>Close</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const onMarkComplete = async () => {
    setError(null);
    setBusy("complete");
    try {
      await updateTask(task.id, { status: "completed" });
      removeTask(task.id);
      router.back();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(null);
    }
  };

  const onDelete = async () => {
    setError(null);
    setBusy("delete");
    try {
      await deleteTask(task.id);
      removeTask(task.id);
      router.back();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(null);
    }
  };

  const importanceLabel = IMPORTANCE_LABELS[task.importance] ?? "Normal";
  const dueText = task.due_at
    ? new Date(task.due_at).toLocaleString()
    : "No due date";
  const clusterText = cluster?.name ?? "No cluster";

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <View style={styles.handle} />

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.title}>{task.title}</Text>

        {task.description ? (
          <Text style={styles.description}>{task.description}</Text>
        ) : null}

        <View style={styles.metaRow}>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>Cluster</Text>
            <View style={styles.metaValueRow}>
              {cluster ? (
                <View style={[styles.clusterDot, { backgroundColor: cluster.color }]} />
              ) : null}
              <Text style={styles.metaValue}>{clusterText}</Text>
            </View>
          </View>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>Importance</Text>
            <Text style={styles.metaValue}>{task.importance} / 10 · {importanceLabel}</Text>
          </View>
        </View>

        <View style={styles.metaCell}>
          <Text style={styles.metaLabel}>Due</Text>
          <Text style={styles.metaValue}>{dueText}</Text>
        </View>

        <View style={styles.metaCell}>
          <Text style={styles.metaLabel}>Pressure</Text>
          <Text style={styles.metaValue}>{task.pressure_score.toFixed(1)} / 10</Text>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          onPress={onDelete}
          disabled={busy !== null}
          style={[styles.secondaryBtn, busy && styles.btnDisabled]}
        >
          {busy === "delete" ? (
            <ActivityIndicator color={colors.overdue} />
          ) : (
            <Text style={styles.secondaryBtnText}>Delete</Text>
          )}
        </Pressable>
        <Pressable
          onPress={onMarkComplete}
          disabled={busy !== null}
          style={[styles.primaryBtn, busy && styles.btnDisabled]}
        >
          {busy === "complete" ? (
            <ActivityIndicator color="white" />
          ) : (
            <Text style={styles.primaryBtnText}>Mark complete</Text>
          )}
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  // Visual grab handle at the top — pure decoration, the system gesture
  // works regardless.
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.line,
    alignSelf: "center",
    marginTop: 8,
    marginBottom: 12,
  },
  body: { paddingHorizontal: 24, paddingBottom: 40 },
  title: { color: colors.ink, fontSize: 22, fontWeight: "700", marginBottom: 8 },
  description: { color: colors.inkDim, fontSize: 14, marginBottom: 14, lineHeight: 20 },
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
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderTopColor: colors.line,
    borderTopWidth: 1,
  },
  primaryBtn: {
    flex: 2,
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryBtnText: { color: "white", fontSize: 15, fontWeight: "700" },
  secondaryBtn: {
    flex: 1,
    backgroundColor: "transparent",
    borderColor: colors.overdue,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  secondaryBtnText: { color: colors.overdue, fontSize: 15, fontWeight: "600" },
  btnDisabled: { opacity: 0.5 },
});
