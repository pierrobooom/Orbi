// Tasks tab — flat list of every active task in pressure-desc order.
// Each row taps into the same /task-detail sheet the canvas uses, so
// editing is consistent across surfaces.

import { useRouter, type Href } from "expo-router";
import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useUniverseStore } from "@/stores/universeStore";
import { colors } from "@/theme/colors";
import type { ServerTask } from "@/services/api";

export default function TasksScreen() {
  const router = useRouter();
  const status = useUniverseStore((s) => s.status);
  const serverTasks = useUniverseStore((s) => s.serverTasks);
  const clusters = useUniverseStore((s) => s.clusters);
  const errorMessage = useUniverseStore((s) => s.errorMessage);
  const hydrate = useUniverseStore((s) => s.hydrate);

  const [refreshing, setRefreshing] = useState(false);

  // Active tasks sorted by pressure desc, then by due_at asc as the
  // tiebreaker — most urgent first, and within a pressure tier the
  // task that's due sooner sits higher. Tasks with no due_at sink
  // to the bottom of their pressure tier.
  const items = useMemo(
    () =>
      serverTasks
        .filter((t) => t.status === "active")
        .sort((a, b) => {
          if (b.pressure_score !== a.pressure_score) {
            return b.pressure_score - a.pressure_score;
          }
          if (a.due_at && b.due_at) return a.due_at.localeCompare(b.due_at);
          if (a.due_at) return -1;
          if (b.due_at) return 1;
          return 0;
        }),
    [serverTasks],
  );

  const clusterLookup = useMemo(() => {
    const map = new Map<string, { name: string; color: string }>();
    for (const c of clusters) map.set(c.id, { name: c.name, color: c.color });
    return map;
  }, [clusters]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await hydrate();
    } finally {
      setRefreshing(false);
    }
  }, [hydrate]);

  if (status === "loading" || status === "idle") {
    return (
      <SafeAreaView style={styles.root} edges={["top"]}>
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} />
        </View>
      </SafeAreaView>
    );
  }

  if (status === "error") {
    return (
      <SafeAreaView style={styles.root} edges={["top"]}>
        <View style={styles.centered}>
          <Text style={styles.errorTitle}>Could not load tasks</Text>
          <Text style={styles.errorBody}>{errorMessage ?? "Unknown error"}</Text>
          <Pressable onPress={() => hydrate()} style={styles.retryBtn}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Tasks</Text>
        <Text style={styles.headerCount}>
          {items.length} active
        </Text>
      </View>

      {items.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>No active tasks</Text>
          <Text style={styles.emptyBody}>
            Hold the mic or tap + on the Universe to add one.
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <TaskRow
              task={item}
              cluster={
                item.parent_cluster_id
                  ? clusterLookup.get(item.parent_cluster_id)
                  : undefined
              }
              onPress={() =>
                router.push({
                  pathname: "/task-detail",
                  params: { id: item.id },
                })
              }
            />
          )}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.accent}
            />
          }
        />
      )}
    </SafeAreaView>
  );
}

interface TaskRowProps {
  task: ServerTask;
  cluster: { name: string; color: string } | undefined;
  onPress: () => void;
}

function TaskRow({ task, cluster, onPress }: TaskRowProps) {
  const due = task.due_at ? new Date(task.due_at) : null;
  const isOverdue =
    due !== null && due < new Date();

  return (
    <Pressable onPress={onPress} style={styles.row} android_ripple={{ color: colors.line }}>
      <View
        style={[
          styles.pressureBar,
          { backgroundColor: isOverdue ? colors.overdue : cluster?.color ?? colors.drift },
        ]}
      />
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {task.title}
        </Text>
        <View style={styles.rowMeta}>
          {cluster ? (
            <View style={styles.metaPill}>
              <View style={[styles.clusterDot, { backgroundColor: cluster.color }]} />
              <Text style={styles.metaText}>{cluster.name}</Text>
            </View>
          ) : null}
          {due ? (
            <Text style={[styles.dueText, isOverdue && styles.dueOverdue]}>
              {due.toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </Text>
          ) : null}
        </View>
      </View>
      <Text style={styles.pressureScore}>{task.pressure_score.toFixed(1)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    paddingHorizontal: 22,
    paddingTop: 10,
    paddingBottom: 14,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  headerTitle: { color: colors.ink, fontSize: 22, fontWeight: "700" },
  headerCount: { color: colors.inkDim, fontSize: 12, fontWeight: "500" },
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
  emptyTitle: { color: colors.ink, fontSize: 17, fontWeight: "600", marginBottom: 6 },
  emptyBody: { color: colors.inkDim, fontSize: 13, textAlign: "center", lineHeight: 19 },
  listContent: { paddingBottom: 40 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingRight: 22,
  },
  pressureBar: { width: 3, height: 36, borderRadius: 2, marginHorizontal: 22 },
  rowBody: { flex: 1 },
  rowTitle: { color: colors.ink, fontSize: 15, fontWeight: "500", marginBottom: 4 },
  rowMeta: { flexDirection: "row", alignItems: "center", gap: 10 },
  metaPill: { flexDirection: "row", alignItems: "center", gap: 5 },
  clusterDot: { width: 8, height: 8, borderRadius: 4 },
  metaText: { color: colors.inkDim, fontSize: 11, fontWeight: "500" },
  dueText: { color: colors.inkDim, fontSize: 11 },
  dueOverdue: { color: colors.overdue, fontWeight: "700" },
  pressureScore: { color: colors.inkDim, fontSize: 13, fontWeight: "600", marginLeft: 8 },
  separator: { height: 1, backgroundColor: colors.line, marginLeft: 47 },
});
