// "Move to cluster" sheet.
//
// Reached by long-pressing a task bubble in the drilled cluster view, or
// from the cluster row in task detail. Moving a task was already
// possible — task-detail → Edit → cluster picker — but it was buried
// two levels down and nobody found it.
//
// Drag-and-drop would be the obvious gesture, and it is deliberately NOT
// what this is. The universe is two-level: the top view shows cluster
// bubbles with no tasks, and the drilled view shows one cluster's tasks
// with no other clusters. A task bubble and its destination cluster are
// therefore never on screen together, so there is nothing to drag onto.
// A long-press picker gets to the same outcome in one gesture.

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
import { ApiError, updateTask } from "@/services/api";
import { useUniverseStore } from "@/stores/universeStore";
import { colors } from "@/theme/colors";

export default function MoveTaskScreen() {
  const t = useT();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const taskId = Array.isArray(id) ? id[0] : id;

  const getServerTask = useUniverseStore((s) => s.getServerTask);
  const serverClusters = useUniverseStore((s) => s.serverClusters);
  const replaceTask = useUniverseStore((s) => s.replaceTask);

  const task = taskId ? getServerTask(taskId) : undefined;
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Drift is offered as a real destination: "not in any cluster" is a
  // legitimate place for a task to live, and without it there'd be no
  // way to take a task back out of a cluster.
  const options = useMemo(
    () => [
      ...serverClusters.map((c) => ({
        id: c.id as string | null,
        name: c.name,
        color: c.color,
      })),
      { id: null, name: t("Adrift (no cluster)"), color: colors.drift },
    ],
    [serverClusters, t],
  );

  const move = async (clusterId: string | null) => {
    if (!task || busyId) return;
    if ((task.parent_cluster_id ?? null) === clusterId) {
      router.back();
      return;
    }
    setError(null);
    setBusyId(clusterId ?? "__drift__");
    try {
      const updated = await updateTask(task.id, { parent_cluster_id: clusterId });
      replaceTask(updated);
      router.back();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      setError(msg);
      setBusyId(null);
    }
  };

  if (!task) {
    return (
      <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
        <View style={styles.centered}>
          <Text style={styles.errorTitle}>{t("Task not found")}</Text>
          <Pressable onPress={() => router.back()} style={styles.secondary}>
            <Text style={styles.secondaryText}>{t("Close")}</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const currentId = task.parent_cluster_id ?? null;

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.headerCancel} numberOfLines={1}>{t("Cancel")}</Text>
        </Pressable>
        <Text style={styles.headerTitle}>{t("Move task")}</Text>
        <View style={{ minWidth: 64 }} />
      </View>

      <ScrollView
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
        <Text style={styles.taskTitle} numberOfLines={2}>
          {task.title}
        </Text>
        <Text style={styles.label}>{t("Move to")}</Text>

        {options.map((option) => {
          const isCurrent = option.id === currentId;
          const key = option.id ?? "__drift__";
          return (
            <Pressable
              key={key}
              onPress={() => move(option.id)}
              disabled={busyId !== null}
              style={[styles.option, isCurrent && styles.optionCurrent]}
            >
              <View style={[styles.dot, { backgroundColor: option.color }]} />
              <Text style={[styles.optionText, isCurrent && styles.optionTextCurrent]}>
                {option.name}
              </Text>
              {busyId === key ? (
                <ActivityIndicator size="small" color={colors.inkDim} />
              ) : isCurrent ? (
                <MaterialIcons name="check" size={18} color={colors.accent} />
              ) : null}
            </Pressable>
          );
        })}

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>
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
  headerCancel: { color: colors.inkDim, fontSize: 14, minWidth: 64 },
  body: { padding: 24 },
  taskTitle: { color: colors.ink, fontSize: 19, fontWeight: "700" },
  label: {
    color: colors.inkDim,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginTop: 24,
    marginBottom: 10,
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    marginBottom: 8,
  },
  optionCurrent: { borderColor: colors.accent, backgroundColor: colors.panel },
  dot: { width: 10, height: 10, borderRadius: 5 },
  optionText: { color: colors.ink, fontSize: 15, flex: 1 },
  optionTextCurrent: { fontWeight: "700" },
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
});
