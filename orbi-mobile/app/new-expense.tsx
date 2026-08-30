// Create-expense modal. Amount + merchant + optional date.
//
// Categorization happens server-side: the backend runs the merchant
// against its rule table first, then (for Pro/Genius) falls back to an
// AI call for unknown merchants. The user can override category later
// from the entry detail (future slice). For this slice, we never block
// the user on category — we just send the raw merchant and let the
// backend categorise.

import DateTimePicker from "@react-native-community/datetimepicker";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
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

import { useT } from "@/i18n";
import { ApiError, createFinanceEntry } from "@/services/api";
import { useFinanceStore } from "@/stores/financeStore";
import { colors } from "@/theme/colors";

function isoDate(d: Date): string {
  // YYYY-MM-DD in local time — entries are dated by calendar day from
  // the user's perspective, not by UTC midnight. Backend stores as date
  // (not timestamp) so timezone doesn't round-trip into the value.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function NewExpenseScreen() {
  const t = useT();
  const router = useRouter();
  const addEntry = useFinanceStore((s) => s.addEntry);

  const [amount, setAmount] = useState("");
  const [merchant, setMerchant] = useState("");
  const [entryDate, setEntryDate] = useState<Date>(() => new Date());
  const [showPicker, setShowPicker] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reject anything that isn't a positive number with at most two
  // decimal places. We parse with parseFloat to be tolerant of trailing
  // junk that getNumericInputProps already filters on iOS.
  const numericAmount = parseFloat(amount);
  const canSubmit =
    merchant.trim().length > 0 &&
    !Number.isNaN(numericAmount) &&
    numericAmount > 0 &&
    !submitting;

  const onSubmit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const created = await createFinanceEntry({
        amount: numericAmount,
        merchant: merchant.trim(),
        entry_date: isoDate(entryDate),
        entry_type: "expense",
      });
      addEntry(created);
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
            <Text style={styles.headerCancel} numberOfLines={1}>{t("Cancel")}</Text>
          </Pressable>
          <Text style={styles.headerTitle}>{t("New expense")}</Text>
          <View style={{ minWidth: 64 }} />
        </View>

        <ScrollView
          keyboardDismissMode="on-drag"
          style={styles.flex}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.label}>{t("Amount")}</Text>
          <View style={styles.amountRow}>
            <Text style={styles.currencySymbol}>£</Text>
            <TextInput
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor={colors.inkDim}
              style={styles.amountInput}
              autoFocus
            
            returnKeyType="done"
            onSubmitEditing={() => Keyboard.dismiss()}
          />
          </View>

          <Text style={styles.label}>{t("Merchant")}</Text>
          <TextInput
            value={merchant}
            onChangeText={setMerchant}
            autoCapitalize="words"
            autoCorrect={false}
            placeholder={t("Tesco, Uber, Netflix…")}
            placeholderTextColor={colors.inkDim}
            style={styles.input}
          
            returnKeyType="done"
            onSubmitEditing={() => Keyboard.dismiss()}
          />
          <Text style={styles.hint}>
            {t(
              "Known merchants categorize automatically. Unknowns stay uncategorized on Spark; Pro and Genius use AI to guess.",
            )}
          </Text>

          <Text style={styles.label}>{t("Date")}</Text>
          <Pressable onPress={() => setShowPicker(true)} style={styles.dateBtn}>
            <Text style={styles.dateText}>
              {entryDate.toLocaleDateString(undefined, {
                weekday: "long",
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </Text>
          </Pressable>

          {showPicker ? (
            <DateTimePicker
              value={entryDate}
              mode="date"
              display={Platform.OS === "ios" ? "spinner" : "default"}
              themeVariant="dark"
              onChange={(event, date) => {
                if (Platform.OS === "android") setShowPicker(false);
                if (event.type === "set" && date) setEntryDate(date);
                if (event.type === "dismissed") setShowPicker(false);
              }}
            />
          ) : null}

          {Platform.OS === "ios" && showPicker ? (
            <Pressable onPress={() => setShowPicker(false)} style={styles.doneRow}>
              <Text style={styles.doneText}>{t("Done")}</Text>
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
              <Text style={styles.primaryText}>{t("Log expense")}</Text>
            )}
          </Pressable>
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
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  headerTitle: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  headerCancel: { color: colors.inkDim, fontSize: 14, minWidth: 64 },
  scrollContent: { paddingHorizontal: 24, paddingTop: 20, paddingBottom: 40 },
  label: {
    color: colors.inkDim,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 1,
    marginBottom: 8,
    marginTop: 14,
    textTransform: "uppercase",
  },
  amountRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  currencySymbol: { color: colors.ink, fontSize: 24, fontWeight: "700", marginRight: 8 },
  amountInput: { flex: 1, color: colors.ink, fontSize: 32, fontWeight: "700" },
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
  hint: { color: colors.inkDim, fontSize: 11, marginTop: 6, lineHeight: 15 },
  dateBtn: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  dateText: { color: colors.ink, fontSize: 14 },
  doneRow: { alignSelf: "flex-end", paddingVertical: 8, paddingHorizontal: 12 },
  doneText: { color: colors.accent, fontSize: 14, fontWeight: "600" },
  error: { color: colors.overdue, fontSize: 13, marginTop: 14 },
  footer: { paddingHorizontal: 24, paddingVertical: 12 },
  primary: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryDisabled: { opacity: 0.5 },
  primaryText: { color: "white", fontSize: 15, fontWeight: "700" },
});
