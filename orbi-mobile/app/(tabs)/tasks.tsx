// Tasks tab — every active task, with sorting and filtering.
//
// Two view toggles sit alongside the sort chips:
//   Overdue — only tasks past their due date. Composes with sorting, so
//     "overdue, grouped by cluster" is one tap each.
//   Done — the last 7 days of completed tasks, struck through.
//
// The Done view exists because completing and deleting a task looked
// identical: both simply removed it from every surface, so finishing
// something left no trace. Completed tasks were already being fetched
// (the API returns everything non-archived) and thrown away by a
// status === "active" filter here.
//
// Sorting: pressure (default), due date, or cluster. Cluster mode switches
// the FlatList for a SectionList so each cluster gets a header.
//
// Filtering is two-layer and deliberately so:
//   1. Local substring match over title / description / label / cluster
//      name. Instant, offline, zero cost — covers the common case where
//      the user types a word that literally appears in the task.
//   2. Semantic match via POST /tasks/search (pgvector), debounced and
//      fired only after the local pass. This is what makes "car" surface
//      "MOT booking" — a task that shares no substring with the query.
//      Semantic-only hits are tagged "related" so the user understands
//      why a row with no visible match is in the list.
//
// The semantic layer is additive: local hits always rank first and the
// list stays usable if the network or the embedding provider is down.

import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { SafeAreaView } from "react-native-safe-area-context";

import { useT } from "@/i18n";
import { useUniverseStore } from "@/stores/universeStore";
import { colors } from "@/theme/colors";
import { searchTasks, type ServerTask } from "@/services/api";

type SortMode = "pressure" | "due" | "cluster";

const SORT_LABELS: Record<SortMode, string> = {
  pressure: "Priority",
  due: "Due date",
  cluster: "Cluster",
};

// Long enough that a fast typist doesn't fire a request per keystroke,
// short enough that the results feel like they belong to what was typed.
const SEMANTIC_DEBOUNCE_MS = 400;
// Below this the query is too vague to spend an embedding call on.
const SEMANTIC_MIN_CHARS = 3;

// How far back the Done view looks. A week is the horizon that makes
// "what did I get through?" answerable without becoming an archive.
const DONE_WINDOW_DAYS = 7;

interface ClusterMeta {
  name: string;
  color: string;
}

function matchesLocally(
  task: ServerTask,
  cluster: ClusterMeta | undefined,
  needle: string,
): boolean {
  if (task.title?.toLowerCase().includes(needle)) return true;
  if (task.description?.toLowerCase().includes(needle)) return true;
  if (task.label?.toLowerCase().includes(needle)) return true;
  if (cluster?.name.toLowerCase().includes(needle)) return true;
  return false;
}

function byPressure(a: ServerTask, b: ServerTask): number {
  if (b.pressure_score !== a.pressure_score) {
    return b.pressure_score - a.pressure_score;
  }
  if (a.due_at && b.due_at) return a.due_at.localeCompare(b.due_at);
  if (a.due_at) return -1;
  if (b.due_at) return 1;
  return 0;
}

// Undated tasks sink to the bottom rather than sorting as "epoch".
function byDue(a: ServerTask, b: ServerTask): number {
  if (a.due_at && b.due_at) return a.due_at.localeCompare(b.due_at);
  if (a.due_at) return -1;
  if (b.due_at) return 1;
  return byPressure(a, b);
}

export default function TasksScreen() {
  const t = useT();
  const router = useRouter();
  const status = useUniverseStore((s) => s.status);
  const serverTasks = useUniverseStore((s) => s.serverTasks);
  // serverClusters, not the canvas `clusters` — the latter holds only the
  // synthetic search/drilled cluster while those views are active, which
  // would blank every cluster name on this screen.
  const serverClusters = useUniverseStore((s) => s.serverClusters);
  const errorMessage = useUniverseStore((s) => s.errorMessage);
  const hydrate = useUniverseStore((s) => s.hydrate);

  const [refreshing, setRefreshing] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("pressure");
  const [query, setQuery] = useState("");
  const [semanticIds, setSemanticIds] = useState<string[]>([]);
  const [semanticBusy, setSemanticBusy] = useState(false);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [showDone, setShowDone] = useState(false);

  const clusterLookup = useMemo(() => {
    const map = new Map<string, ClusterMeta>();
    for (const c of serverClusters) map.set(c.id, { name: c.name, color: c.color });
    return map;
  }, [serverClusters]);

  const activeTasks = useMemo(
    () => serverTasks.filter((t) => t.status === "active"),
    [serverTasks],
  );

  // Completed within the window, newest first. Falls back to updated_at
  // for rows completed before migration 0010 added completed_at, which
  // is the same guess the backfill made.
  const doneTasks = useMemo(() => {
    const cutoff = Date.now() - DONE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    return serverTasks
      .filter((task) => {
        if (task.status !== "completed") return false;
        const stamp = task.completed_at ?? task.updated_at;
        if (!stamp) return false;
        return new Date(stamp).getTime() >= cutoff;
      })
      .sort((a, b) => {
        const av = new Date(a.completed_at ?? a.updated_at ?? 0).getTime();
        const bv = new Date(b.completed_at ?? b.updated_at ?? 0).getTime();
        return bv - av;
      });
  }, [serverTasks]);

  // The pool every filter and sort below operates on.
  const pool = useMemo(() => {
    if (showDone) return doneTasks;
    if (!overdueOnly) return activeTasks;
    const now = Date.now();
    return activeTasks.filter(
      (task) => task.due_at != null && new Date(task.due_at).getTime() < now,
    );
  }, [showDone, doneTasks, overdueOnly, activeTasks]);

  // --- semantic layer ----------------------------------------------------
  // Tracks the query each response belongs to so a slow request for an
  // earlier query can't overwrite results for what the user typed since.
  const latestQueryRef = useRef("");
  useEffect(() => {
    const trimmed = query.trim();
    latestQueryRef.current = trimmed;
    if (trimmed.length < SEMANTIC_MIN_CHARS) {
      setSemanticIds([]);
      setSemanticBusy(false);
      return;
    }
    setSemanticBusy(true);
    const handle = setTimeout(async () => {
      try {
        const res = await searchTasks(trimmed);
        if (latestQueryRef.current !== trimmed) return; // stale
        setSemanticIds(res.hits.map((h) => h.id));
      } catch {
        // Semantic search is an enhancement — a failure silently leaves
        // the local substring results in place rather than erroring out.
        if (latestQueryRef.current === trimmed) setSemanticIds([]);
      } finally {
        if (latestQueryRef.current === trimmed) setSemanticBusy(false);
      }
    }, SEMANTIC_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  // --- filter + sort -----------------------------------------------------
  const { items, semanticOnlyIds } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return { items: pool.slice(), semanticOnlyIds: new Set<string>() };
    }
    const localHits: ServerTask[] = [];
    const localIds = new Set<string>();
    for (const t of pool) {
      const cluster = t.parent_cluster_id
        ? clusterLookup.get(t.parent_cluster_id)
        : undefined;
      if (matchesLocally(t, cluster, needle)) {
        localHits.push(t);
        localIds.add(t.id);
      }
    }
    const semanticOnly = new Set<string>();
    const semanticHits: ServerTask[] = [];
    for (const id of semanticIds) {
      if (localIds.has(id)) continue;
      // Semantic hits are matched against the current pool, so a search
      // while "Done" is on can't resurrect an active task.
      const task = pool.find((t) => t.id === id);
      if (task) {
        semanticHits.push(task);
        semanticOnly.add(task.id);
      }
    }
    return { items: [...localHits, ...semanticHits], semanticOnlyIds: semanticOnly };
  }, [pool, clusterLookup, query, semanticIds]);

  const sorted = useMemo(() => {
    const copy = items.slice();
    // Done tasks arrive newest-first and have no meaningful pressure or
    // due ordering left — preserve that unless the user asked to group
    // them by cluster.
    if (showDone && sortMode !== "cluster") return copy;
    // In cluster mode the sections handle grouping; within a section
    // pressure order is the most useful secondary ordering.
    if (sortMode === "due") return copy.sort(byDue);
    return copy.sort(byPressure);
  }, [items, sortMode, showDone]);

  const sections = useMemo(() => {
    if (sortMode !== "cluster") return [];
    const groups = new Map<string, { meta: ClusterMeta; data: ServerTask[] }>();
    const UNASSIGNED = "__drift__";
    // Named `task`, not `t` — `t` is the translate function in this scope.
    for (const task of sorted) {
      const key = task.parent_cluster_id ?? UNASSIGNED;
      const meta =
        (task.parent_cluster_id
          ? clusterLookup.get(task.parent_cluster_id)
          : undefined) ?? { name: t("Adrift"), color: colors.drift };
      if (!groups.has(key)) groups.set(key, { meta, data: [] });
      groups.get(key)!.data.push(task);
    }
    // Biggest clusters first; Drift always last so the catch-all doesn't
    // lead the screen.
    return Array.from(groups.entries())
      .sort((a, b) => {
        if (a[0] === UNASSIGNED) return 1;
        if (b[0] === UNASSIGNED) return -1;
        return b[1].data.length - a[1].data.length;
      })
      .map(([key, group]) => ({
        key,
        title: group.meta.name,
        color: group.meta.color,
        data: group.data,
      }));
  }, [sortMode, sorted, clusterLookup, t]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await hydrate();
    } finally {
      setRefreshing(false);
    }
  }, [hydrate]);

  const openTask = useCallback(
    (id: string) => router.push({ pathname: "/task-detail", params: { id } }),
    [router],
  );

  const renderRow = useCallback(
    (item: ServerTask) => (
      <TaskRow
        task={item}
        cluster={
          item.parent_cluster_id ? clusterLookup.get(item.parent_cluster_id) : undefined
        }
        related={semanticOnlyIds.has(item.id)}
        showCluster={sortMode !== "cluster"}
        done={item.status === "completed"}
        onPress={() => openTask(item.id)}
      />
    ),
    [clusterLookup, openTask, semanticOnlyIds, sortMode],
  );

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
          <Text style={styles.errorTitle}>{t("Could not load tasks")}</Text>
          <Text style={styles.errorBody}>{errorMessage ?? "Unknown error"}</Text>
          <Pressable onPress={() => hydrate()} style={styles.retryBtn}>
            <Text style={styles.retryText}>{t("Retry")}</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const filtering = query.trim().length > 0;

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t("Tasks")}</Text>
        <Text style={styles.headerCount}>
          {filtering
            ? t("{n} of {total}", { n: sorted.length, total: pool.length })
            : showDone
              ? t("{n} done", { n: pool.length })
              : overdueOnly
                ? t("{n} overdue", { n: pool.length })
                : t("{n} active", { n: activeTasks.length })}
        </Text>
      </View>

      <View style={styles.searchRow}>
        <MaterialIcons name="search" size={17} color={colors.inkDim} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t("Filter tasks")}
          placeholderTextColor={colors.inkDim}
          style={styles.searchInput}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        
            onSubmitEditing={() => Keyboard.dismiss()}
          />
        {semanticBusy ? <ActivityIndicator size="small" color={colors.inkDim} /> : null}
        {query.length > 0 && !semanticBusy ? (
          <Pressable onPress={() => setQuery("")} hitSlop={10}>
            <MaterialIcons name="close" size={17} color={colors.inkDim} />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.filterRow}>
        <Pressable
          onPress={() => {
            setOverdueOnly((v) => !v);
            // Overdue is meaningless for finished work.
            if (!overdueOnly) setShowDone(false);
          }}
          style={[styles.filterChip, overdueOnly && styles.filterChipActive]}
        >
          <MaterialIcons
            name="schedule"
            size={13}
            color={overdueOnly ? "white" : colors.overdue}
          />
          <Text style={[styles.filterChipText, overdueOnly && styles.filterChipTextActive]}>
            {t("Overdue")}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => {
            setShowDone((v) => !v);
            if (!showDone) setOverdueOnly(false);
          }}
          style={[styles.filterChip, showDone && styles.filterChipActive]}
        >
          <MaterialIcons
            name={showDone ? "check-box" : "check-box-outline-blank"}
            size={13}
            color={showDone ? "white" : colors.inkDim}
          />
          <Text style={[styles.filterChipText, showDone && styles.filterChipTextActive]}>
            {t("Show done")}
          </Text>
        </Pressable>
      </View>

      <View style={styles.sortRow}>
        {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => {
          const active = mode === sortMode;
          return (
            <Pressable
              key={mode}
              onPress={() => setSortMode(mode)}
              style={[styles.sortChip, active && styles.sortChipActive]}>
              <Text style={[styles.sortChipText, active && styles.sortChipTextActive]}>
                {t(SORT_LABELS[mode])}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {sorted.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>
            {filtering
              ? t("No matches")
              : showDone
                ? t("Nothing completed yet")
                : overdueOnly
                  ? t("Nothing overdue")
                  : t("No active tasks")}
          </Text>
          <Text style={styles.emptyBody}>
            {filtering
              ? t('Nothing matches "{q}".', { q: query.trim() })
              : showDone
                ? t("Tasks you complete show up here for {n} days.", {
                    n: DONE_WINDOW_DAYS,
                  })
                : overdueOnly
                  ? t("Nothing is past its due date. Good.")
                  : t("Hold the mic or tap + on the Universe to add one.")}
          </Text>
        </View>
      ) : sortMode === "cluster" ? (
        <SectionList
          keyboardDismissMode="on-drag"
          sections={sections}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => renderRow(item)}
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <View style={[styles.clusterDot, { backgroundColor: section.color }]} />
              <Text style={styles.sectionTitle}>{section.title}</Text>
              <Text style={styles.sectionCount}>{section.data.length}</Text>
            </View>
          )}
          stickySectionHeadersEnabled={false}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.accent}
            />
          }
        />
      ) : (
        <FlatList
          keyboardDismissMode="on-drag"
          data={sorted}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => renderRow(item)}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
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
  cluster: ClusterMeta | undefined;
  related: boolean;
  showCluster: boolean;
  done: boolean;
  onPress: () => void;
}

function TaskRow({ task, cluster, related, showCluster, done, onPress }: TaskRowProps) {
  const t = useT();
  const due = task.due_at ? new Date(task.due_at) : null;
  // A finished task can't be overdue, whatever its due date says.
  const isOverdue = !done && due !== null && due < new Date();
  const completed = task.completed_at ?? task.updated_at ?? null;

  return (
    <Pressable onPress={onPress} style={styles.row} android_ripple={{ color: colors.line }}>
      <View
        style={[
          styles.pressureBar,
          { backgroundColor: isOverdue ? colors.overdue : cluster?.color ?? colors.drift },
        ]}
      />
      <View style={styles.rowBody}>
        <Text
          style={[styles.rowTitle, done && styles.rowTitleDone]}
          numberOfLines={2}
        >
          {task.title}
        </Text>
        <View style={styles.rowMeta}>
          {cluster && showCluster ? (
            <View style={styles.metaPill}>
              <View style={[styles.clusterDot, { backgroundColor: cluster.color }]} />
              <Text style={styles.metaText}>{cluster.name}</Text>
            </View>
          ) : null}
          {done && completed ? (
            <Text style={styles.dueText}>
              {new Date(completed).toLocaleDateString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
              })}
            </Text>
          ) : due ? (
            <Text style={[styles.dueText, isOverdue && styles.dueOverdue]}>
              {due.toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </Text>
          ) : null}
          {related ? (
            // The query doesn't appear anywhere in this row — say so, or
            // it reads as a bug.
            <View style={styles.relatedPill}>
              <Text style={styles.relatedText}>{t("related")}</Text>
            </View>
          ) : null}
        </View>
      </View>
      {done ? (
        <MaterialIcons name="check" size={16} color={colors.inkDim} />
      ) : (
        <Text style={styles.pressureScore}>{task.pressure_score.toFixed(1)}</Text>
      )}
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
    paddingBottom: 12,
  },
  headerTitle: { color: colors.ink, fontSize: 22, fontWeight: "700" },
  headerCount: { color: colors.inkDim, fontSize: 12, fontWeight: "500" },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 22,
    paddingHorizontal: 12,
    height: 38,
    borderRadius: 10,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.line,
  },
  searchInput: { flex: 1, color: colors.ink, fontSize: 14, padding: 0 },
  filterRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 22,
    paddingTop: 12,
  },
  filterChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.line,
  },
  filterChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  filterChipText: { color: colors.inkDim, fontSize: 12, fontWeight: "600" },
  filterChipTextActive: { color: "white" },
  sortRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 22,
    paddingTop: 10,
    paddingBottom: 12,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  sortChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.line,
  },
  sortChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  sortChipText: { color: colors.inkDim, fontSize: 12, fontWeight: "600" },
  sortChipTextActive: { color: "white" },
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
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 22,
    paddingTop: 18,
    paddingBottom: 8,
  },
  sectionTitle: { color: colors.ink, fontSize: 13, fontWeight: "700", flex: 1 },
  sectionCount: { color: colors.inkDim, fontSize: 12, fontWeight: "600" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingRight: 22,
  },
  pressureBar: { width: 3, height: 36, borderRadius: 2, marginHorizontal: 22 },
  rowBody: { flex: 1 },
  rowTitle: { color: colors.ink, fontSize: 15, fontWeight: "500", marginBottom: 4 },
  // Thin strike plus dimmed text — "finished", not "cancelled".
  rowTitleDone: {
    color: colors.inkDim,
    textDecorationLine: "line-through",
    textDecorationStyle: "solid",
  },
  rowMeta: { flexDirection: "row", alignItems: "center", gap: 10 },
  metaPill: { flexDirection: "row", alignItems: "center", gap: 5 },
  clusterDot: { width: 8, height: 8, borderRadius: 4 },
  metaText: { color: colors.inkDim, fontSize: 11, fontWeight: "500" },
  dueText: { color: colors.inkDim, fontSize: 11 },
  dueOverdue: { color: colors.overdue, fontWeight: "700" },
  relatedPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: colors.line,
  },
  relatedText: { color: colors.inkDim, fontSize: 9, fontWeight: "700", letterSpacing: 0.4 },
  pressureScore: { color: colors.inkDim, fontSize: 13, fontWeight: "600", marginLeft: 8 },
  separator: { height: 1, backgroundColor: colors.line, marginLeft: 47 },
});
