// Cluster editor — create / rename / recolor / delete.
//
// Routed two ways:
//   /cluster-editor?id=new           → fresh cluster, no Delete button
//   /cluster-editor?id={cluster_id}  → load existing, show Delete button
//
// Triggers:
//   - Long-press a cluster bubble on the universe canvas
//   - Long-press the + FAB on the universe canvas
//   - Settings → Universe → New cluster
//
// The synthetic Drift cluster can't be edited or deleted — the screen
// refuses with an explanation when the id matches DRIFT_ID.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
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

import {
  ApiError,
  createCluster,
  deleteCluster,
  updateCluster,
} from "@/services/api";
import { translate, useT } from "@/i18n";
import { useUniverseStore } from "@/stores/universeStore";
import { colors } from "@/theme/colors";

// Cluster palette. First six are the canonical kind colors so manual
// clusters can match LLM-created ones visually; the rest give the user
// more variety. Avoid red (#ff4d6d is reserved for overdue) and gray
// (drift's color) so users don't accidentally pick state-coded shades.
const COLOR_PALETTE: { color: string; label: string }[] = [
  { color: colors.work,     label: "Blue" },
  { color: colors.health,   label: "Green" },
  { color: colors.finance,  label: "Amber" },
  { color: colors.personal, label: "Purple" },
  { color: colors.home,     label: "Orange" },
  { color: colors.learning, label: "Cyan" },
  { color: "#f9967d",       label: "Coral" },
  { color: "#e056b4",       label: "Magenta" },
  { color: "#b6e85b",       label: "Lime" },
  { color: "#6b6ff5",       label: "Indigo" },
];

const DRIFT_ID = "synthetic-drift";

export default function ClusterEditorScreen() {
  const t = useT();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const id = (params.id ?? "new").toString();
  const isNew = id === "new";

  const hydrate = useUniverseStore((s) => s.hydrate);
  const exitCluster = useUniverseStore((s) => s.exitCluster);
  const serverClusters = useUniverseStore((s) => s.serverClusters);

  // Drift is synthetic — backend doesn't know about it. We catch it
  // up front so the user sees a clear message instead of a 404.
  const isDrift = id === DRIFT_ID;

  const existing = useMemo(
    () => (isNew || isDrift ? null : serverClusters.find((c) => c.id === id) ?? null),
    [id, isNew, isDrift, serverClusters],
  );

  // Set of colors already taken by OTHER clusters (excluding this one
  // if we're editing). Drift is ignored — it has its own reserved
  // gray that isn't in the palette anyway. Comparison is case-insensitive
  // because hex strings can vary.
  const takenColors = useMemo(() => {
    const set = new Set<string>();
    for (const c of serverClusters) {
      if (c.id === id) continue; // editing this one — its current color is fine
      if (c.color) set.add(c.color.toLowerCase());
    }
    return set;
  }, [serverClusters, id]);

  // Pick the first palette color not in use as the default for new
  // clusters. Falls back to "Coral" if every color is taken so we
  // never start on null.
  const defaultColor = useMemo(() => {
    const free = COLOR_PALETTE.find((opt) => !takenColors.has(opt.color.toLowerCase()));
    return (free ?? COLOR_PALETTE[6]).color;
  }, [takenColors]);

  const [name, setName] = useState(existing?.name ?? "");
  const [color, setColor] = useState(existing?.color ?? defaultColor);
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (existing) {
      setName(existing.name);
      setColor(existing.color);
    } else {
      // New cluster — reset to the first unused color when the palette
      // shifts (e.g., a cluster gets deleted while the modal is open).
      setColor(defaultColor);
    }
  }, [existing, defaultColor]);

  const canSave = name.trim().length > 0 && !busy && !isDrift;

  const onSave = async () => {
    setError(null);
    setBusy("save");
    try {
      if (isNew) {
        await createCluster({ name: name.trim(), color });
      } else {
        await updateCluster(id, { name: name.trim(), color });
      }
      await hydrate();
      router.back();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(null);
    }
  };

  const onDeletePress = () => {
    if (isNew || isDrift) return;
    Alert.alert(translate("Delete cluster?"), translate("Tasks inside this cluster will move to Drift."),
      [
        { text: translate("Cancel"), style: "cancel" },
        {
          text: translate("Delete"),
          style: "destructive",
          onPress: async () => {
            setError(null);
            setBusy("delete");
            try {
              await deleteCluster(id);
              // Make sure we're not stuck inside a cluster view that
              // no longer exists.
              exitCluster();
              await hydrate();
              router.back();
            } catch (e) {
              setError(e instanceof ApiError ? e.message : String(e));
              setBusy(null);
            }
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        <View style={styles.header}>
          <Pressable
            onPress={() => router.back()}
            hitSlop={12}
            style={styles.headerSide}
            accessibilityLabel="Close"
          >
            <View style={styles.headerCloseGroup}>
              <MaterialIcons name="chevron-left" size={22} color={colors.inkDim} />
              <Text style={styles.headerCloseText}>{t("Cancel")}</Text>
            </View>
          </Pressable>
          <Text style={styles.headerTitle}>
            {isNew ? t("New cluster") : t("Edit cluster")}
          </Text>
          <Pressable
            onPress={onSave}
            disabled={!canSave}
            hitSlop={12}
            style={styles.headerSide}
            accessibilityLabel="Save cluster"
          >
            {busy === "save" ? (
              <ActivityIndicator color={colors.accent} />
            ) : (
              <Text style={[styles.saveText, !canSave && styles.saveDisabled]}>
                {t("Save")}
              </Text>
            )}
          </Pressable>
        </View>

        <ScrollView
          keyboardDismissMode="on-drag" contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {isDrift ? (
            <View style={styles.driftCard}>
              <Text style={styles.driftTitle}>{t("Drift is the catch-all")}</Text>
              <Text style={styles.driftBody}>
                {t(
                  "Drift collects tasks that haven't been assigned to a cluster yet. It can't be renamed, recolored, or deleted. Move tasks out of Drift by editing each one, or use Organise clusters to let Orbi suggest a new home for them.",
                )}
              </Text>
            </View>
          ) : (
            <>
              <Text style={styles.label}>{t("Name")}</Text>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder={t("Work, Health, Reading…")}
                placeholderTextColor={colors.inkDim}
                maxLength={40}
                style={styles.input}
                autoFocus={isNew}
                autoCapitalize="words"
              
            returnKeyType="done"
            onSubmitEditing={() => Keyboard.dismiss()}
          />

              <Text style={[styles.label, styles.labelSpaced]}>{t("Color")}</Text>
              <Text style={styles.colorHint}>
                {t("Dimmed colors are already used by another cluster.")}
              </Text>
              <View style={styles.swatchRow}>
                {COLOR_PALETTE.map((opt) => {
                  const selected = opt.color === color;
                  const taken =
                    takenColors.has(opt.color.toLowerCase()) && opt.color !== color;
                  return (
                    <Pressable
                      key={opt.color}
                      onPress={() => setColor(opt.color)}
                      style={[
                        styles.swatch,
                        { backgroundColor: opt.color },
                        selected && styles.swatchSelected,
                        taken && styles.swatchTaken,
                      ]}
                      accessibilityLabel={
                        taken
                          ? `Color ${opt.label}, already used by another cluster`
                          : `Color ${opt.label}`
                      }
                    >
                      {selected ? (
                        <MaterialIcons name="check" size={18} color="white" />
                      ) : taken ? (
                        <View style={styles.takenDot} />
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>

              <View style={styles.previewRow}>
                <View style={[styles.previewBubble, { backgroundColor: color }]} />
                <View style={styles.previewMeta}>
                  <Text style={styles.previewName}>
                    {name.trim() || "Untitled cluster"}
                  </Text>
                  <Text style={styles.previewHint}>{t("Preview")}</Text>
                </View>
              </View>

              {error ? <Text style={styles.error}>{error}</Text> : null}

              {!isNew ? (
                <Pressable
                  onPress={onDeletePress}
                  disabled={busy !== null}
                  style={[styles.deleteBtn, busy && styles.btnDisabled]}
                >
                  {busy === "delete" ? (
                    <ActivityIndicator color={colors.overdue} />
                  ) : (
                    <>
                      <MaterialIcons name="delete-outline" size={18} color={colors.overdue} />
                      <Text style={styles.deleteText}>{t("Delete cluster")}</Text>
                    </>
                  )}
                </Pressable>
              ) : null}
            </>
          )}
        </ScrollView>
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
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  headerSide: { minWidth: 72 },
  headerTitle: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  headerCloseGroup: { flexDirection: "row", alignItems: "center", marginLeft: -6 },
  headerCloseText: { color: colors.inkDim, fontSize: 14 },
  saveText: { color: colors.accent, fontSize: 14, fontWeight: "700", textAlign: "right" },
  saveDisabled: { color: colors.inkDim },
  body: { padding: 20, paddingBottom: 40 },
  label: { color: colors.inkDim, fontSize: 11, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase" },
  labelSpaced: { marginTop: 24 },
  input: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 8,
    color: colors.ink,
    fontSize: 15,
  },
  colorHint: { color: colors.inkDim, fontSize: 11, marginTop: 6 },
  swatchRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginTop: 10,
  },
  swatch: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    borderColor: "transparent",
    borderWidth: 2,
  },
  swatchSelected: { borderColor: "white" },
  swatchTaken: { opacity: 0.32 },
  takenDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  previewRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 28,
    padding: 14,
    backgroundColor: colors.panel,
    borderRadius: 12,
    borderColor: colors.line,
    borderWidth: 1,
    gap: 14,
  },
  previewBubble: {
    width: 46,
    height: 46,
    borderRadius: 23,
  },
  previewMeta: { flex: 1 },
  previewName: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  previewHint: { color: colors.inkDim, fontSize: 11, marginTop: 2 },
  error: { color: colors.overdue, fontSize: 12, marginTop: 14 },
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 32,
    paddingVertical: 14,
    borderRadius: 12,
    borderColor: colors.overdue,
    borderWidth: 1,
  },
  deleteText: { color: colors.overdue, fontSize: 14, fontWeight: "600" },
  btnDisabled: { opacity: 0.5 },
  driftCard: {
    padding: 16,
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
  },
  driftTitle: { color: colors.ink, fontSize: 15, fontWeight: "700" },
  driftBody: { color: colors.inkDim, fontSize: 13, lineHeight: 18, marginTop: 6 },
});
