// Categories — the user's own, not a fixed list.
//
// These were a constant in three places: a rule table in Python and two
// picker arrays in the app. That works exactly as long as everyone's life is
// the same shape. Someone with a dog, a boat, a band or a chronic illness has
// a category nobody else needs, and the honest answer to "where does this
// go?" was "Other, for ever".
//
// WHAT CAN AND CANNOT BE DELETED
// A category the user added can be deleted once nothing points at it. A
// seeded one is hidden instead, because entries, budgets and learned rules
// already reference its slug and a dangling slug renders as nothing at all.
// Neither is allowed to take spending history with it: silently moving a
// year of transactions into "Other" because someone tidied a list is not a
// tidy-up, it is data loss.
//
// THE RE-SORT BUTTON
// Categorisation improves over time — a rule gets added, or the user teaches
// it a merchant. This applies that to everything still unsorted. It is a
// button rather than something automatic because it is the only part of the
// ladder that can cost anything, and a cost the user chose is a different
// thing from one that happened to them.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useState } from "react";
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

import { translate, useT } from "@/i18n";
import {
  ApiError,
  createCategory,
  deleteCategory,
  listCategories,
  recategorise,
  updateCategory,
  type FinanceCategory,
} from "@/services/api";
import { colors } from "@/theme/colors";

export default function CategoriesScreen() {
  const t = useT();
  const router = useRouter();

  const [categories, setCategories] = useState<FinanceCategory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [sorting, setSorting] = useState(false);
  // Set when the form is renaming rather than creating.
  const [editing, setEditing] = useState<FinanceCategory | null>(null);

  const load = useCallback(async () => {
    try {
      setCategories(await listCategories());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setCategories((current) => current ?? []);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onSave = async () => {
    const name = label.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      if (editing) {
        await updateCategory(editing.id, { label: name });
      } else {
        await createCategory({ label: name });
      }
      setLabel("");
      setEditing(null);
      setAdding(false);
      Keyboard.dismiss();
      await load();
    } catch (e) {
      Alert.alert(
        translate("Could not add it"),
        e instanceof ApiError ? e.message : String(e),
      );
    } finally {
      setBusy(false);
    }
  };

  /** Rename through the same form the Add button uses.
   *
   * Alert.prompt was the obvious choice and is iOS-only — on Android it is
   * simply undefined, so renaming would have done nothing at all with no
   * error to explain why. */
  const onRename = (category: FinanceCategory) => {
    setEditing(category);
    setLabel(category.label);
    setAdding(true);
  };

  const onToggleHidden = async (category: FinanceCategory) => {
    // Optimistic: the row dims immediately and reverts if the save fails.
    setCategories((current) =>
      (current ?? []).map((c) =>
        c.id === category.id ? { ...c, hidden: !c.hidden } : c,
      ),
    );
    try {
      await updateCategory(category.id, { hidden: !category.hidden });
    } catch (e) {
      setCategories((current) =>
        (current ?? []).map((c) =>
          c.id === category.id ? { ...c, hidden: category.hidden } : c,
        ),
      );
      Alert.alert(
        translate("Could not save"),
        e instanceof ApiError ? e.message : String(e),
      );
    }
  };

  const onDelete = (category: FinanceCategory) => {
    Alert.alert(
      translate("Delete {label}?", { label: category.label }),
      translate("Only works if nothing is filed under it."),
      [
        { text: translate("Cancel"), style: "cancel" },
        {
          text: translate("Delete"),
          style: "destructive",
          onPress: async () => {
            try {
              await deleteCategory(category.id);
              await load();
            } catch (e) {
              Alert.alert(
                translate("Could not delete"),
                e instanceof ApiError ? e.message : String(e),
              );
            }
          },
        },
      ],
    );
  };

  const onResort = async () => {
    setSorting(true);
    try {
      const result = await recategorise();
      Alert.alert(
        translate("Sorted"),
        result.categorised === 0
          ? translate("Nothing else could be placed automatically.")
          : translate("{n} transactions sorted. {left} still unsorted.", {
              n: result.categorised,
              left: result.remaining,
            }),
      );
    } catch (e) {
      Alert.alert(
        translate("Could not sort"),
        e instanceof ApiError ? e.message : String(e),
      );
    } finally {
      setSorting(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={12} style={styles.headerSide}>
            <MaterialIcons name="chevron-left" size={24} color={colors.inkDim} />
          </Pressable>
          <Text style={styles.headerTitle}>{t("Categories")}</Text>
          <Pressable
            onPress={() => {
              setAdding((v) => !v);
              setEditing(null);
              setLabel("");
            }}
            hitSlop={12}
            style={styles.headerSide}
          >
            <MaterialIcons
              name={adding ? "close" : "add"}
              size={24}
              color={colors.accent}
            />
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
        >
          {adding ? (
            <View style={styles.form}>
              <TextInput
                value={label}
                onChangeText={setLabel}
                placeholder={t("Pets, gym, travel…")}
                placeholderTextColor={colors.inkDim}
                style={styles.input}
                autoFocus
                maxLength={40}
                returnKeyType="done"
                onSubmitEditing={onSave}
              />
              <Pressable
                onPress={onSave}
                disabled={!label.trim() || busy}
                style={[styles.addBtn, (!label.trim() || busy) && styles.disabled]}
              >
                {busy ? (
                  <ActivityIndicator color={colors.canvas} size="small" />
                ) : (
                  <Text style={styles.addBtnText}>
                    {editing ? t("Save") : t("Add")}
                  </Text>
                )}
              </Pressable>
            </View>
          ) : null}

          {categories === null ? (
            <ActivityIndicator color={colors.accent} style={styles.loader} />
          ) : (
            categories.map((category) => (
              <Pressable
                key={category.id}
                onLongPress={() =>
                  category.is_default ? onToggleHidden(category) : onDelete(category)
                }
                onPress={() => onRename(category)}
                style={[styles.row, category.hidden && styles.rowHidden]}
              >
                <MaterialIcons
                  name={(category.icon as never) ?? "label"}
                  size={20}
                  color={category.hidden ? colors.inkDim : colors.accent}
                />
                <View style={styles.rowBody}>
                  <Text style={[styles.rowLabel, category.hidden && styles.dim]}>
                    {category.label}
                  </Text>
                  {category.hidden ? (
                    <Text style={styles.rowNote}>{t("Hidden")}</Text>
                  ) : !category.is_default ? (
                    <Text style={styles.rowNote}>{t("Yours")}</Text>
                  ) : null}
                </View>
                <Pressable onPress={() => onToggleHidden(category)} hitSlop={10}>
                  <MaterialIcons
                    name={category.hidden ? "visibility-off" : "visibility"}
                    size={18}
                    color={colors.inkDim}
                  />
                </Pressable>
              </Pressable>
            ))
          )}

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            onPress={onResort}
            disabled={sorting}
            style={[styles.resort, sorting && styles.disabled]}
          >
            {sorting ? (
              <ActivityIndicator color={colors.ink} size="small" />
            ) : (
              <>
                <MaterialIcons name="auto-fix-high" size={17} color={colors.ink} />
                <Text style={styles.resortText}>{t("Sort what's left")}</Text>
              </>
            )}
          </Pressable>

          <Text style={styles.footHint}>
            {t(
              "Tap to rename. Long-press one of your own to delete it. Changing a transaction's category teaches Orbi that shop for next time.",
            )}
          </Text>
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
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  headerSide: { minWidth: 40, alignItems: "center" },
  headerTitle: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  body: { padding: 16, paddingBottom: 48, gap: 8 },
  loader: { marginTop: 40 },
  form: { flexDirection: "row", gap: 10, marginBottom: 8 },
  input: {
    flex: 1,
    color: colors.ink,
    fontSize: 15,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
  },
  addBtn: {
    justifyContent: "center",
    paddingHorizontal: 20,
    borderRadius: 10,
    backgroundColor: colors.accent,
  },
  addBtnText: { color: colors.canvas, fontSize: 14, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 13,
    paddingHorizontal: 14,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
  },
  rowHidden: { opacity: 0.55 },
  rowBody: { flex: 1 },
  rowLabel: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  dim: { color: colors.inkDim },
  rowNote: { color: colors.inkDim, fontSize: 10, marginTop: 2 },
  error: { color: colors.overdue, fontSize: 12, marginTop: 10 },
  resort: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 18,
    paddingVertical: 13,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
  },
  resortText: { color: colors.ink, fontSize: 14, fontWeight: "600" },
  footHint: {
    color: colors.inkDim,
    fontSize: 11,
    lineHeight: 17,
    marginTop: 14,
    textAlign: "center",
  },
});
