// Cluster reorganisation review modal.
//
// Flow: opened from Settings or the small organise icon next to the
// universe FAB. Calls /clusters/auto-organize on mount, shows each
// proposed action as a checkbox row (default-on). User unchecks any
// they don't want, taps Apply → POST /clusters/apply-organisation
// with the approved subset, then triggers a universe rehydrate so
// the canvas redraws.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useRouter } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  ApiError,
  applyOrganisation,
  proposeOrganisation,
  type ProposalAction,
} from "@/services/api";
import { useUniverseStore } from "@/stores/universeStore";
import { colors } from "@/theme/colors";

export default function ClusterProposalScreen() {
  const router = useRouter();
  // Pull from serverClusters (the full list, always present) rather
  // than `clusters` (the canvas state, which is only the focused
  // cluster when the user is in drilled view). Using the canvas list
  // here caused action rows to render "Merge ? into ?" because the
  // referenced clusters weren't in scope. ServerCluster has the same
  // {id, name} fields the helper needs, so swapping is drop-in.
  const clusters = useUniverseStore((s) => s.serverClusters);
  const serverTasks = useUniverseStore((s) => s.serverTasks);
  const hydrate = useUniverseStore((s) => s.hydrate);

  // null until the propose call returns; [] means "no suggestions".
  const [actions, setActions] = useState<ProposalAction[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    proposeOrganisation()
      .then((res) => {
        if (cancelled) return;
        setActions(res.actions);
        // Default every action to checked. The user's job is to
        // unselect anything they disagree with, not to opt in.
        setSelected(new Set(res.actions.map((_, idx) => idx)));
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : String(e));
        setActions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onToggle = (idx: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const onApply = async () => {
    if (!actions || actions.length === 0) return;
    const approved = actions.filter((_, idx) => selected.has(idx));
    if (approved.length === 0) {
      router.back();
      return;
    }
    setApplying(true);
    try {
      const result = await applyOrganisation(approved);
      // Refetch universe so the canvas reflects the new clusters /
      // moves immediately. Hydrate also resets the layout positions.
      await hydrate();
      const total = Object.values(result.applied).reduce((a, b) => a + b, 0);
      Alert.alert(
        "Universe updated",
        `${total} change${total === 1 ? "" : "s"} applied.`,
        [{ text: "OK", onPress: () => router.back() }],
      );
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      Alert.alert("Couldn't apply", msg);
    } finally {
      setApplying(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} disabled={applying}>
          <View style={styles.headerCloseGroup}>
            <MaterialIcons name="chevron-left" size={22} color={colors.inkDim} />
            <Text style={styles.headerCloseText}>Close</Text>
          </View>
        </Pressable>
        <Text style={styles.headerTitle}>Organise clusters</Text>
        <View style={{ width: 90 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.hint}>Reviewing your universe…</Text>
          </View>
        ) : error ? (
          <View style={styles.center}>
            <Text style={styles.error}>{error}</Text>
          </View>
        ) : actions && actions.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>Your universe is already tidy.</Text>
            <Text style={styles.hint}>
              Try again once you've added a few more tasks.
            </Text>
          </View>
        ) : (
          <>
            <Text style={styles.intro}>
              Tap to deselect anything you don't want. Approved changes apply when you tap Apply.
            </Text>
            {actions?.map((action, idx) => (
              <ActionRow
                key={`${action.type}-${idx}`}
                action={action}
                checked={selected.has(idx)}
                onToggle={() => onToggle(idx)}
                clusters={clusters}
                taskCount={action.task_ids?.length ?? 0}
                taskTitleLookup={(taskId) =>
                  serverTasks.find((t) => t.id === taskId)?.title ?? null
                }
              />
            ))}
          </>
        )}
      </ScrollView>

      {actions && actions.length > 0 ? (
        <View style={styles.footer}>
          <Pressable
            onPress={onApply}
            disabled={applying || selected.size === 0}
            style={[
              styles.applyBtn,
              (applying || selected.size === 0) && styles.applyBtnDisabled,
            ]}
          >
            {applying ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text style={styles.applyBtnText}>
                Apply {selected.size > 0 ? `(${selected.size})` : ""}
              </Text>
            )}
          </Pressable>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

// Resolve a cluster id → name for the action labels. Returns the raw
// id when the cluster isn't in the canvas list (deleted between propose
// and render, for example).
function nameForCluster(clusterId: string | undefined, clusters: { id: string; name: string }[]): string {
  if (!clusterId) return "?";
  return clusters.find((c) => c.id === clusterId)?.name ?? "?";
}

function describeAction(
  action: ProposalAction,
  clusters: { id: string; name: string }[],
  taskCount: number,
): { title: string; subtitle: string } {
  switch (action.type) {
    case "create_cluster":
      return {
        title: `Create cluster "${action.name ?? "?"}"`,
        subtitle: `Move ${taskCount} drift task${taskCount === 1 ? "" : "s"} into it`,
      };
    case "move_tasks":
      return {
        title: `Move ${taskCount} task${taskCount === 1 ? "" : "s"}`,
        subtitle: `Into "${nameForCluster(action.cluster_id, clusters)}"`,
      };
    case "merge_clusters":
      return {
        title: `Merge "${nameForCluster(action.source_id, clusters)}"`,
        subtitle: `Into "${nameForCluster(action.target_id, clusters)}"`,
      };
    case "rename_cluster":
      return {
        title: `Rename "${nameForCluster(action.cluster_id, clusters)}"`,
        subtitle: `→ "${action.new_name ?? "?"}"`,
      };
    default:
      return { title: action.type, subtitle: "" };
  }
}

function ActionRow({
  action,
  checked,
  onToggle,
  clusters,
  taskCount,
  taskTitleLookup,
}: {
  action: ProposalAction;
  checked: boolean;
  onToggle: () => void;
  clusters: { id: string; name: string }[];
  taskCount: number;
  taskTitleLookup: (taskId: string) => string | null;
}) {
  const { title, subtitle } = useMemo(
    () => describeAction(action, clusters, taskCount),
    [action, clusters, taskCount],
  );

  // For create_cluster / move_tasks we list the affected task titles
  // inline so the user knows exactly what's moving. Capped at three to
  // keep the row compact.
  const affectedTitles = useMemo(() => {
    if (!action.task_ids || action.task_ids.length === 0) return [];
    return action.task_ids
      .slice(0, 3)
      .map(taskTitleLookup)
      .filter((t): t is string => !!t);
  }, [action.task_ids, taskTitleLookup]);

  return (
    <Pressable onPress={onToggle} style={styles.row}>
      <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
        {checked ? (
          <MaterialIcons name="check" size={16} color="white" />
        ) : null}
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle}>{title}</Text>
        {subtitle ? <Text style={styles.rowSubtitle}>{subtitle}</Text> : null}
        {action.reason ? <Text style={styles.rowReason}>{action.reason}</Text> : null}
        {affectedTitles.length > 0 ? (
          <Text style={styles.rowTaskList} numberOfLines={2}>
            {affectedTitles.join(" • ")}
            {action.task_ids && action.task_ids.length > 3
              ? ` • +${action.task_ids.length - 3} more`
              : ""}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  headerTitle: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  headerCloseGroup: { flexDirection: "row", alignItems: "center", marginLeft: -6 },
  headerCloseText: { color: colors.inkDim, fontSize: 14 },
  body: { padding: 16, paddingBottom: 40 },
  intro: { color: colors.inkDim, fontSize: 12, marginBottom: 14, lineHeight: 17 },
  center: { alignItems: "center", justifyContent: "center", paddingVertical: 60 },
  hint: { color: colors.inkDim, fontSize: 12, marginTop: 12, textAlign: "center" },
  empty: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  error: { color: colors.overdue, fontSize: 13, textAlign: "center" },
  row: {
    flexDirection: "row",
    backgroundColor: colors.panel,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    gap: 12,
    borderColor: colors.line,
    borderWidth: 1,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderColor: colors.line,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  checkboxChecked: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  rowBody: { flex: 1 },
  rowTitle: { color: colors.ink, fontSize: 14, fontWeight: "600" },
  rowSubtitle: { color: colors.inkDim, fontSize: 12, marginTop: 2 },
  rowReason: { color: colors.inkDim, fontSize: 11, marginTop: 6, lineHeight: 15 },
  rowTaskList: { color: colors.inkDim, fontSize: 11, marginTop: 6, fontStyle: "italic" },
  footer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopColor: colors.line,
    borderTopWidth: 1,
  },
  applyBtn: {
    backgroundColor: colors.accent,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  applyBtnDisabled: { opacity: 0.4 },
  applyBtnText: { color: "white", fontSize: 15, fontWeight: "700" },
});
