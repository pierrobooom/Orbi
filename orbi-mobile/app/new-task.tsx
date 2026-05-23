// Create-task modal. Title (required) + cluster picker (optional) + due
// date (optional). Submits to POST /api/v1/tasks and prepends the result
// to the universeStore so the new bubble shows up without a re-fetch.

import DateTimePicker from "@react-native-community/datetimepicker";
import { useRouter } from "expo-router";
import React, { useState } from "react";
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

const SYNTHETIC_DRIFT_ID = "synthetic-drift";

export default function NewTaskScreen() {
  const router = useRouter();
  const clusters = useUniverseStore((s) => s.clusters);
  const addTask = useUniverseStore((s) => s.addTask);

  const [title, setTitle] = useState("");
  // null means "No cluster" (sent as parent_cluster_id: null)
  const [clusterId, setClusterId] = useState<string | null>(null);
  const [dueAt, setDueAt] = useState<Date | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only real backend clusters are selectable. The synthetic Drift
  // cluster is just a layout fiction — its ID isn't a valid foreign key.
  const realClusters = clusters.filter((c) => c.id !== SYNTHETIC_DRIFT_ID);

  const canSubmit = title.trim().length > 0 && !submitting;

  const onSubmit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const created = await createTask({
        title: title.trim(),
        parent_cluster_id: clusterId,
        due_at: dueAt ? dueAt.toISOString() : null,
      });
      addTask(created);
      router.back();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      setError(msg);
      setSubmitting(false);
    }
  };

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
          <Text style={styles.headerTitle}>New task</Text>
          <View style={{ width: 50 }} />
        </View>

        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <TextInput
            value={title}
            onChangeText={setTitle}
            autoFocus
            placeholder="What needs doing?"
            placeholderTextColor={colors.inkDim}
            style={styles.titleInput}
            multiline
          />

          <Text style={styles.fieldLabel}>Cluster</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipRow}
          >
            <ClusterChip
              label="No cluster"
              selected={clusterId === null}
              onPress={() => setClusterId(null)}
              color={colors.drift}
            />
            {realClusters.map((c) => (
              <ClusterChip
                key={c.id}
                label={c.name}
                selected={clusterId === c.id}
                onPress={() => setClusterId(c.id)}
                color={c.color}
              />
            ))}
          </ScrollView>

          <Text style={styles.fieldLabel}>Due</Text>
          <View style={styles.dueRow}>
            <Pressable
              onPress={() => setShowPicker(true)}
              style={styles.dueButton}
            >
              <Text style={styles.dueText}>
                {dueAt ? dueAt.toLocaleString() : "No due date"}
              </Text>
            </Pressable>
            {dueAt ? (
              <Pressable
                onPress={() => setDueAt(null)}
                hitSlop={8}
                style={styles.clearDue}
              >
                <Text style={styles.clearDueText}>Clear</Text>
              </Pressable>
            ) : null}
          </View>

          {showPicker ? (
            <DateTimePicker
              value={dueAt ?? new Date()}
              mode="datetime"
              display={Platform.OS === "ios" ? "spinner" : "default"}
              themeVariant="dark"
              onChange={(event, date) => {
                // Android closes the picker after a selection; iOS keeps
                // it open on the spinner (we close on done via the body tap).
                if (Platform.OS === "android") setShowPicker(false);
                if (event.type === "set" && date) setDueAt(date);
                if (event.type === "dismissed") setShowPicker(false);
              }}
            />
          ) : null}

          {Platform.OS === "ios" && showPicker ? (
            <Pressable onPress={() => setShowPicker(false)} style={styles.doneRow}>
              <Text style={styles.doneText}>Done</Text>
            </Pressable>
          ) : null}

          {error ? <Text style={styles.error}>{error}</Text> : null}
        </ScrollView>

        <View style={styles.footer}>
          <Pressable
            onPress={onSubmit}
            disabled={!canSubmit}
            style={[styles.primary, !canSubmit && styles.primaryDisabled]}
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

interface ChipProps {
  label: string;
  selected: boolean;
  color: string;
  onPress: () => void;
}

function ClusterChip({ label, selected, color, onPress }: ChipProps) {
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.chip,
        { borderColor: color },
        selected && { backgroundColor: color },
      ]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
        {label}
      </Text>
    </Pressable>
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
  scrollContent: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 40 },
  titleInput: {
    color: colors.ink,
    fontSize: 22,
    fontWeight: "600",
    paddingVertical: 8,
    marginBottom: 22,
  },
  fieldLabel: {
    color: colors.inkDim,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 1,
    marginBottom: 10,
    marginTop: 6,
    textTransform: "uppercase",
  },
  chipRow: { gap: 8, paddingRight: 20, paddingBottom: 4 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipText: { color: colors.ink, fontSize: 13, fontWeight: "500" },
  chipTextSelected: { color: "white", fontWeight: "700" },
  dueRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 16 },
  dueButton: {
    flex: 1,
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  dueText: { color: colors.ink, fontSize: 14 },
  clearDue: { paddingHorizontal: 6 },
  clearDueText: { color: colors.inkDim, fontSize: 13 },
  doneRow: { alignSelf: "flex-end", paddingVertical: 8, paddingHorizontal: 12 },
  doneText: { color: colors.accent, fontSize: 14, fontWeight: "600" },
  error: { color: colors.overdue, fontSize: 13, marginTop: 12 },
  footer: { paddingHorizontal: 20, paddingVertical: 12 },
  primary: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryDisabled: { opacity: 0.5 },
  primaryText: { color: "white", fontSize: 15, fontWeight: "700" },
});
