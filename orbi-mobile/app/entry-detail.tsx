// Money-entry detail bottom sheet — slides up when the user taps an
// entry row. Mirrors task-detail.tsx in shape: view mode shows the
// fields, Edit mode swaps inputs in, and there's a delete option.
//
// Re-running the backend's categorisation happens server-side when the
// merchant changes (and category isn't passed explicitly), so the
// user can fix a "Tesco" typo and the entry re-categorises on its own.

import DateTimePicker from "@react-native-community/datetimepicker";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
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

import { useT } from "@/i18n";
import { ApiError, deleteFinanceEntry, updateFinanceEntry } from "@/services/api";
import { useFinanceStore } from "@/stores/financeStore";
import { colors } from "@/theme/colors";

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
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [editAmount, setEditAmount] = useState("");
  const [editMerchant, setEditMerchant] = useState("");
  const [editDate, setEditDate] = useState<Date>(new Date());
  const [editNotes, setEditNotes] = useState("");
  const [showDatePicker, setShowDatePicker] = useState(false);

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
        <View style={styles.header}>
          <Pressable
            onPress={() => router.back()}
            hitSlop={12}
            style={styles.headerSideLeft}
            accessibilityLabel="Close"
          >
            <Text style={styles.headerCloseText}>{t("Close")}</Text>
          </Pressable>
          <Text style={styles.headerTitle}>{t("Entry")}</Text>
          {mode === "view" ? (
            <Pressable
              onPress={enterEdit}
              hitSlop={12}
              style={styles.headerSideRight}
              accessibilityLabel="Edit entry"
            >
              <Text style={styles.editLinkText}>{t("Edit")}</Text>
            </Pressable>
          ) : (
            <View style={styles.headerSideRight} />
          )}
        </View>

        <ScrollView
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
                <View style={styles.metaCell}>
                  <Text style={styles.metaLabel}>{t("Category")}</Text>
                  <Text style={styles.metaValue}>{entry.category}</Text>
                </View>
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
                />
              </View>

              <Text style={styles.metaLabel}>{t("Merchant")}</Text>
              <TextInput
                value={editMerchant}
                onChangeText={setEditMerchant}
                autoCapitalize="words"
                style={styles.input}
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

        <View style={styles.footer}>
          {mode === "view" ? (
            <Pressable
              onPress={onDelete}
              disabled={busy !== null}
              style={[styles.deleteBtn, busy && styles.btnDisabled]}
            >
              {busy === "delete" ? (
                <ActivityIndicator color={colors.overdue} />
              ) : (
                <Text style={styles.deleteBtnText}>{t("Delete entry")}</Text>
              )}
            </Pressable>
          ) : (
            <>
              <Pressable
                onPress={cancelEdit}
                disabled={busy !== null}
                style={[styles.cancelBtn, busy && styles.btnDisabled]}
              >
                <Text style={styles.cancelBtnText}>{t("Cancel")}</Text>
              </Pressable>
              <Pressable
                onPress={onSave}
                disabled={busy !== null}
                style={[styles.primaryBtn, busy && styles.btnDisabled]}
              >
                {busy === "save" ? (
                  <ActivityIndicator color="white" />
                ) : (
                  <Text style={styles.primaryBtnText}>{t("Save changes")}</Text>
                )}
              </Pressable>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  flex: { flex: 1 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  headerSideLeft: { minWidth: 60, alignItems: "flex-start" },
  headerSideRight: { minWidth: 60, alignItems: "flex-end" },
  headerTitle: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  headerCloseText: { color: colors.inkDim, fontSize: 14 },
  editLinkText: { color: colors.accent, fontSize: 15, fontWeight: "600" },
  body: { paddingHorizontal: 24, paddingTop: 18, paddingBottom: 24 },
  bigAmount: { color: colors.ink, fontSize: 36, fontWeight: "700", marginBottom: 4 },
  merchant: { color: colors.ink, fontSize: 18, fontWeight: "500", marginBottom: 16 },
  title: { color: colors.ink, fontSize: 22, fontWeight: "700", marginBottom: 8 },
  metaRow: { flexDirection: "row", gap: 16, marginBottom: 14 },
  metaCell: { flex: 1, marginBottom: 14 },
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
  footer: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderTopColor: colors.line,
    borderTopWidth: 1,
    backgroundColor: colors.canvas,
  },
  primaryBtn: {
    flex: 2,
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryBtnText: { color: "white", fontSize: 15, fontWeight: "700" },
  cancelBtn: {
    flex: 1,
    backgroundColor: "transparent",
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  cancelBtnText: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  deleteBtn: {
    flex: 1,
    backgroundColor: "transparent",
    borderColor: colors.overdue,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  deleteBtnText: { color: colors.overdue, fontSize: 15, fontWeight: "600" },
  btnDisabled: { opacity: 0.5 },
});
