// Money-entry detail bottom sheet — slides up when the user taps an
// entry row. Mirrors task-detail.tsx in shape: view mode shows the
// fields, Edit mode swaps inputs in, and there's a delete option.
//
// Re-running the backend's categorisation happens server-side when the
// merchant changes (and category isn't passed explicitly), so the
// user can fix a "Tesco" typo and the entry re-categorises on its own.

import DateTimePicker from "@react-native-community/datetimepicker";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ActionBar } from "@/components/action-bar";
import { ScreenHeader } from "@/components/screen-header";
import { useT } from "@/i18n";
import {
  ApiError,
  deleteFinanceEntry,
  listCategories,
  updateFinanceEntry,
  type FinanceCategory,
} from "@/services/api";
import { formatCategory, isUncategorized } from "@/services/categories";
import { useFinanceStore } from "@/stores/financeStore";
import { colors } from "@/theme/colors";
import { themed } from "@/theme/themed";

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatAmount(amount: number, currency: string): string {
  const symbol = currency === "GBP" ? "£" : currency === "EUR" ? "€" : currency === "USD" ? "$" : "";
  return `${symbol}${amount.toFixed(2)}`;
}

/** The label a user gave this category, falling back to a tidy slug.
 *
 * Categories are the user's own and renameable, so the slug stored on the
 * entry is not what should be shown — but an entry can outlive a category
 * that was hidden, and showing nothing at all is worse than showing the
 * slug prettified. */
function labelFor(slug: string, categories: FinanceCategory[]): string {
  return categories.find((c) => c.slug === slug)?.label ?? formatCategory(slug);
}

function parseDateString(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return new Date();
  return new Date(y, m - 1, d);
}

export default function EntryDetailScreen() {
  const t = useT();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const entryId = Array.isArray(id) ? id[0] : id;

  const replaceEntry = useFinanceStore((s) => s.replaceEntry);
  const removeEntry = useFinanceStore((s) => s.removeEntry);

  // Subscribe directly to entries so a Save re-renders this screen
  // immediately. useMemo over a stable getEntry reference never
  // re-ran after replaceEntry() landed.
  const entry = useFinanceStore((s) =>
    entryId ? s.entries.find((e) => e.id === entryId) : undefined,
  );

  const [mode, setMode] = useState<"view" | "edit">("view");
  const [pickingCategory, setPickingCategory] = useState(false);
  const [categories, setCategories] = useState<FinanceCategory[]>([]);
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [editAmount, setEditAmount] = useState("");
  const [editMerchant, setEditMerchant] = useState("");
  const [editDate, setEditDate] = useState<Date>(new Date());
  const [editNotes, setEditNotes] = useState("");
  const [showDatePicker, setShowDatePicker] = useState(false);

  // Loaded here rather than in the picker so the label is right the first
  // time the screen paints. Must sit above the early return below: a hook
  // after a conditional return is a hook that sometimes does not run.
  useEffect(() => {
    listCategories()
      .then(setCategories)
      .catch(() => setCategories([]));
  }, []);

  if (!entry) {
    return (
      <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
        <View style={styles.centered}>
          <Text style={styles.title}>{t("Entry not found")}</Text>
          <Pressable onPress={() => router.back()} style={styles.secondary}>
            <Text style={styles.secondaryText}>{t("Close")}</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const enterEdit = () => {
    setError(null);
    setEditAmount(entry.amount.toFixed(2));
    setEditMerchant(entry.merchant);
    setEditDate(parseDateString(entry.entry_date));
    setEditNotes(entry.notes ?? "");
    setMode("edit");
  };

  const cancelEdit = () => {
    setMode("view");
    setError(null);
    setShowDatePicker(false);
  };

  const onSave = async () => {
    const amount = parseFloat(editAmount);
    if (Number.isNaN(amount) || amount <= 0) {
      setError("Amount must be a positive number.");
      return;
    }
    if (!editMerchant.trim()) {
      setError("Merchant can't be empty.");
      return;
    }
    setError(null);
    setBusy("save");
    try {
      const trimmedNotes = editNotes.trim();
      const updated = await updateFinanceEntry(entry.id, {
        amount,
        merchant: editMerchant.trim(),
        entry_date: isoDate(editDate),
        notes: trimmedNotes.length > 0 ? trimmedNotes : null,
      });
      replaceEntry(updated);
      setMode("view");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  /** File this entry under a category, and teach the merchant.
   *
   * The teaching happens server-side on the same request: a category the
   * user chose is a fact about that shop, not just about this row.
   */
  const onPickCategory = async (slug: string) => {
    setPickingCategory(false);
    if (!entry || slug === entry.category) return;
    try {
      replaceEntry(await updateFinanceEntry(entry.id, { category: slug }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  const onDelete = async () => {
    setError(null);
    setBusy("delete");
    try {
      await deleteFinanceEntry(entry.id);
      removeEntry(entry.id);
      router.back();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(null);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        {/* Delete lives up here on purpose. Easy to reach and easy to press
            by accident are the same property, and this is the one action on
            the screen that cannot be undone. Everything reachable is at the
            bottom. */}
        <ScreenHeader
          title={t("Entry")}
          backIcon="close"
          action={
            mode === "view"
              ? {
                  icon: "delete-outline",
                  onPress: onDelete,
                  label: "Delete entry",
                  tint: colors.overdue,
                  busy: busy === "delete",
                  disabled: busy !== null,
                }
              : undefined
          }
        />

        <ScrollView
          keyboardDismissMode="on-drag"
          style={styles.flex}
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
        >
          {mode === "view" ? (
            <>
              <Text style={styles.bigAmount}>
                {entry.entry_type === "expense" ? "-" : "+"}
                {formatAmount(entry.amount, entry.currency)}
              </Text>
              <Text style={styles.merchant}>{entry.merchant}</Text>

              <View style={styles.metaRow}>
                {/* Tappable, because this is the only place a person can
                    correct a category — and a correction here teaches the
                    merchant for every future transaction, which is the
                    difference between an app that learns and one that has
                    to be fixed every month. */}
                <Pressable
                  style={styles.metaCell}
                  onPress={() => setPickingCategory(true)}
                >
                  <Text style={styles.metaLabel}>{t("Category")}</Text>
                  <View style={styles.categoryValue}>
                    <Text
                      style={[
                        styles.metaValue,
                        isUncategorized(entry.category) && styles.categoryMissing,
                      ]}
                    >
                      {isUncategorized(entry.category)
                        ? t("Tap to categorise")
                        : labelFor(entry.category, categories)}
                    </Text>
                    <MaterialIcons name="expand-more" size={16} color={colors.inkDim} />
                  </View>
                </Pressable>
                <View style={styles.metaCell}>
                  <Text style={styles.metaLabel}>{t("Date")}</Text>
                  <Text style={styles.metaValue}>
                    {parseDateString(entry.entry_date).toLocaleDateString(undefined, {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </Text>
                </View>
              </View>

              {entry.notes ? (
                <View style={styles.metaCell}>
                  <Text style={styles.metaLabel}>{t("Notes")}</Text>
                  <Text style={styles.metaValue}>{entry.notes}</Text>
                </View>
              ) : null}
            </>
          ) : (
            <>
              <Text style={styles.metaLabel}>{t("Amount")}</Text>
              <View style={styles.amountRow}>
                <Text style={styles.currencySymbol}>
                  {entry.currency === "GBP" ? "£" : entry.currency === "EUR" ? "€" : entry.currency === "USD" ? "$" : entry.currency}
                </Text>
                <TextInput
                  value={editAmount}
                  onChangeText={setEditAmount}
                  keyboardType="decimal-pad"
                  style={styles.amountInput}
                
            returnKeyType="done"
            onSubmitEditing={() => Keyboard.dismiss()}
          />
              </View>

              <Text style={styles.metaLabel}>{t("Merchant")}</Text>
              <TextInput
                value={editMerchant}
                onChangeText={setEditMerchant}
                autoCapitalize="words"
                style={styles.input}
              
            returnKeyType="done"
            onSubmitEditing={() => Keyboard.dismiss()}
          />
              <Text style={styles.hint}>
                {t("Changing the merchant re-runs categorisation.")}
              </Text>

              <Text style={styles.metaLabel}>{t("Date")}</Text>
              {Platform.OS === "ios" ? (
                <View style={styles.dateRow}>
                  <DateTimePicker
                    value={editDate}
                    mode="date"
                    display="compact"
                    themeVariant="dark"
                    onChange={(_event, date) => {
                      if (date) setEditDate(date);
                    }}
                  />
                </View>
              ) : (
                <>
                  <Pressable onPress={() => setShowDatePicker(true)} style={styles.dateBtn}>
                    <Text style={styles.dateText}>
                      {editDate.toLocaleDateString(undefined, {
                        weekday: "long",
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </Text>
                  </Pressable>
                  {showDatePicker ? (
                    <DateTimePicker
                      value={editDate}
                      mode="date"
                      display="default"
                      onChange={(event, date) => {
                        setShowDatePicker(false);
                        if (event.type === "set" && date) setEditDate(date);
                      }}
                    />
                  ) : null}
                </>
              )}

              <Text style={styles.metaLabel}>{t("Notes")}</Text>
              <TextInput
                value={editNotes}
                onChangeText={setEditNotes}
                multiline
                placeholder={t("Optional context")}
                placeholderTextColor={colors.inkDim}
                style={styles.notesInput}
              />
            </>
          )}

          {error ? <Text style={styles.error}>{error}</Text> : null}
        </ScrollView>

        {mode === "view" ? (
          <ActionBar primary={{ label: t("Edit"), onPress: enterEdit }} />
        ) : (
          <ActionBar
            primary={{
              label: t("Save changes"),
              onPress: onSave,
              busy: busy === "save",
              disabled: busy !== null,
            }}
            secondary={{
              label: t("Cancel"),
              onPress: cancelEdit,
              disabled: busy !== null,
            }}
          />
        )}

        <Modal
          visible={pickingCategory}
          transparent
          animationType="fade"
          onRequestClose={() => setPickingCategory(false)}
        >
          <Pressable
            style={styles.sheetBackdrop}
            onPress={() => setPickingCategory(false)}
          >
            <Pressable style={styles.sheet} onPress={() => undefined}>
              <Text style={styles.sheetTitle}>
                {t("File {merchant} under", { merchant: entry.merchant })}
              </Text>
              <ScrollView keyboardShouldPersistTaps="handled">
                {categories
                  .filter((c) => !c.hidden)
                  .map((category) => {
                    const active = category.slug === entry.category;
                    return (
                      <Pressable
                        key={category.id}
                        onPress={() => onPickCategory(category.slug)}
                        style={[styles.option, active && styles.optionSelected]}
                      >
                        <MaterialIcons
                          name={(category.icon as never) ?? "label"}
                          size={18}
                          color={active ? colors.accent : colors.inkDim}
                        />
                        <Text style={styles.optionLabel}>{category.label}</Text>
                        {active ? (
                          <MaterialIcons name="check" size={18} color={colors.accent} />
                        ) : null}
                      </Pressable>
                    );
                  })}
              </ScrollView>
              {/* The way out of a list that doesn't contain what you need.
                  Without it, an unusual purchase has nowhere to go and the
                  answer is "Other" for ever, which is where the whole
                  custom-category feature started. */}
              <Pressable
                onPress={() => {
                  setPickingCategory(false);
                  router.push("/categories");
                }}
                style={styles.manageRow}
              >
                <MaterialIcons name="add" size={18} color={colors.accent} />
                <Text style={styles.manageText}>{t("Manage categories")}</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = themed(() => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  flex: { flex: 1 },
  body: { paddingHorizontal: 24, paddingTop: 18, paddingBottom: 24 },
  bigAmount: { color: colors.ink, fontSize: 36, fontWeight: "700", marginBottom: 4 },
  merchant: { color: colors.ink, fontSize: 18, fontWeight: "500", marginBottom: 16 },
  title: { color: colors.ink, fontSize: 22, fontWeight: "700", marginBottom: 8 },
  metaRow: { flexDirection: "row", gap: 16, marginBottom: 14 },
  metaCell: { flex: 1, marginBottom: 14 },
  categoryValue: { flexDirection: "row", alignItems: "center", gap: 4 },
  categoryMissing: { color: colors.accent, fontStyle: "italic" },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  sheet: {
    maxHeight: "72%",
    backgroundColor: colors.panel,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: 16,
    paddingBottom: 28,
    paddingHorizontal: 14,
  },
  sheetTitle: {
    color: colors.inkDim,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    paddingHorizontal: 6,
    paddingBottom: 8,
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 13,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  optionSelected: { backgroundColor: colors.canvas },
  optionLabel: { flex: 1, color: colors.ink, fontSize: 15, fontWeight: "600" },
  manageRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 8,
    paddingVertical: 13,
    borderTopColor: colors.line,
    borderTopWidth: 1,
  },
  manageText: { color: colors.accent, fontSize: 14, fontWeight: "700" },
  metaLabel: {
    color: colors.inkDim,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  metaValue: { color: colors.ink, fontSize: 14, fontWeight: "500" },
  amountRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginBottom: 14,
  },
  currencySymbol: { color: colors.ink, fontSize: 24, fontWeight: "700", marginRight: 8 },
  amountInput: { flex: 1, color: colors.ink, fontSize: 28, fontWeight: "700" },
  input: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.ink,
    fontSize: 15,
  },
  hint: { color: colors.inkDim, fontSize: 11, marginTop: 6, marginBottom: 6, lineHeight: 15 },
  dateRow: { flexDirection: "row", alignItems: "center", marginBottom: 14 },
  dateBtn: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  dateText: { color: colors.ink, fontSize: 14 },
  notesInput: {
    color: colors.ink,
    fontSize: 14,
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minHeight: 60,
    textAlignVertical: "top",
  },
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
}));
