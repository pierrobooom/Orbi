// Recurring transactions — the predictable half of a month, entered once.
//
// Rent, the gym, Netflix, the phone bill. Typing these in every month is the
// dullest thing a finance app asks for and the usual reason people stop using
// one. A rule states them once and the server materialises the entries.
//
// Nothing is created here. The server's daily job owns materialisation, so a
// rule starting today produces its first entry through exactly the same code
// path as every later one — rather than a special case that only the first
// entry ever exercises, and which is therefore the one that breaks.

import DateTimePicker from "@react-native-community/datetimepicker";
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
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ActionBar } from "@/components/action-bar";
import { ScreenHeader } from "@/components/screen-header";
import { translate, useT } from "@/i18n";
import {
  ApiError,
  createRecurring,
  deleteRecurring,
  listAccounts,
  listRecurring,
  updateRecurring,
  type AccountBalance,
  type Cadence,
  type RecurringTransaction,
} from "@/services/api";
import { colors } from "@/theme/colors";

const CADENCES: { value: Cadence; label: string }[] = [
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
];

// Matches the rule table in services/finance_categorizer.py. Kept short —
// this is a picker, not a taxonomy.
const CATEGORIES = [
  "Subscriptions",
  "Home",
  "Groceries",
  "Transport",
  "Health",
  "Finance",
  "Dining",
  "Shopping",
  "Other",
];

/** Local calendar date as YYYY-MM-DD.
 *
 * NOT toISOString(), which converts to UTC first: west of Greenwich a date
 * picked in the evening comes back as the day before, so a rule set for the
 * 8th would quietly run on the 7th. */
function toIsoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function formatMoney(amount: number, currency: string): string {
  const symbol =
    currency === "EUR" ? "€" : currency === "GBP" ? "£" : currency === "USD" ? "$" : "";
  return `${symbol}${amount.toFixed(2)}`;
}

function describeCadence(rule: RecurringTransaction, t: (k: string, v?: any) => string): string {
  const every = rule.interval_count > 1 ? `${rule.interval_count} ` : "";
  const unit =
    rule.cadence === "weekly"
      ? rule.interval_count > 1 ? t("weeks") : t("week")
      : rule.cadence === "monthly"
        ? rule.interval_count > 1 ? t("months") : t("month")
        : rule.interval_count > 1 ? t("years") : t("year");
  return t("Every {every}{unit}", { every, unit });
}

export default function RecurringScreen() {
  const t = useT();
  const router = useRouter();

  const [rules, setRules] = useState<RecurringTransaction[] | null>(null);
  const [accounts, setAccounts] = useState<AccountBalance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  // New-rule form.
  const [merchant, setMerchant] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [cadence, setCadence] = useState<Cadence>("monthly");
  const [accountId, setAccountId] = useState<string | null>(null);
  // When the first one falls due. Defaults to today so a rule does something
  // straight away, but rent is due on the 8th — for anything that repeats,
  // the start date IS the schedule.
  const [startOn, setStartOn] = useState(new Date());
  const [showStartPicker, setShowStartPicker] = useState(false);
  // An existing rule whose next date is being corrected, if any.
  const [editingDate, setEditingDate] = useState<RecurringTransaction | null>(null);

  const load = useCallback(async () => {
    try {
      const [ruleRows, accountRows] = await Promise.all([listRecurring(), listAccounts()]);
      setRules(ruleRows);
      setAccounts(accountRows);
      if (!accountId) {
        const primary = accountRows.find((r) => r.account.is_primary);
        setAccountId(primary?.account.id ?? accountRows[0]?.account.id ?? null);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setRules((current) => current ?? []);
    }
  }, [accountId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const parsedAmount = Number(amount.replace(",", "."));
  const canAdd =
    merchant.trim().length > 0 && Number.isFinite(parsedAmount) && parsedAmount > 0 && !busy;

  const onAdd = async () => {
    if (!canAdd) return;
    setBusy(true);
    try {
      await createRecurring({
        merchant: merchant.trim(),
        category,
        amount: parsedAmount,
        cadence,
        account_id: accountId,
        entry_type: "expense",
        next_run_on: toIsoDate(startOn),
      });
      setMerchant("");
      setAmount("");
      setAdding(false);
      Keyboard.dismiss();
      await load();
    } catch (e) {
      Alert.alert(translate("Could not save"), e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Move an existing rule's next occurrence.
   *
   * Optimistic, because the alternative is a list that sits unchanged for a
   * round trip after an edit the user just made — which reads as the tap
   * not having registered, and gets tapped again.
   */
  const onChangeNextDate = async (rule: RecurringTransaction, date: Date) => {
    const next_run_on = toIsoDate(date);
    setRules((current) =>
      (current ?? []).map((r) => (r.id === rule.id ? { ...r, next_run_on } : r)),
    );
    try {
      await updateRecurring(rule.id, { next_run_on });
    } catch (e) {
      setRules((current) =>
        (current ?? []).map((r) =>
          r.id === rule.id ? { ...r, next_run_on: rule.next_run_on } : r,
        ),
      );
      Alert.alert(translate("Could not save"), e instanceof ApiError ? e.message : String(e));
    }
  };

  const onToggleActive = async (rule: RecurringTransaction) => {
    // Optimistic: the switch animates now and reverts if the save fails.
    setRules((current) =>
      (current ?? []).map((r) => (r.id === rule.id ? { ...r, active: !r.active } : r)),
    );
    try {
      await updateRecurring(rule.id, { active: !rule.active });
    } catch (e) {
      setRules((current) =>
        (current ?? []).map((r) => (r.id === rule.id ? { ...r, active: rule.active } : r)),
      );
      Alert.alert(translate("Could not save"), e instanceof ApiError ? e.message : String(e));
    }
  };

  const onDelete = (rule: RecurringTransaction) => {
    Alert.alert(
      translate("Delete this rule?"),
      translate("Entries it already created stay — they're money that actually moved."),
      [
        { text: translate("Cancel"), style: "cancel" },
        {
          text: translate("Delete"),
          style: "destructive",
          onPress: async () => {
            try {
              await deleteRecurring(rule.id);
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

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        <ScreenHeader title={t("Memberships")} />

        <ScrollView
          contentContainerStyle={styles.body}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
        >
          {adding ? (
            <View style={styles.form}>
              <TextInput
                value={merchant}
                onChangeText={setMerchant}
                placeholder={t("Netflix, rent, gym…")}
                placeholderTextColor={colors.inkDim}
                style={styles.input}
                autoFocus
                maxLength={120}
              />
              <TextInput
                value={amount}
                onChangeText={setAmount}
                placeholder="0.00"
                placeholderTextColor={colors.inkDim}
                keyboardType="decimal-pad"
                style={[styles.input, styles.mono]}
              />

              {/* When the first one is due.
                  This used to be hard-wired to today, so a rule for rent
                  due on the 8th created an entry the moment it was typed
                  and every month on the wrong day after that. The start
                  date IS the schedule for anything that repeats. */}
              <Text style={styles.formLabel}>{t("First payment")}</Text>
              {Platform.OS === "ios" ? (
                <View style={styles.dateRow}>
                  <DateTimePicker
                    value={startOn}
                    mode="date"
                    display="compact"
                    themeVariant="dark"
                    onChange={(_event, date) => {
                      if (date) setStartOn(date);
                    }}
                  />
                </View>
              ) : (
                <>
                  <Pressable
                    onPress={() => setShowStartPicker(true)}
                    style={styles.dateBtn}
                  >
                    <Text style={styles.dateText}>
                      {startOn.toLocaleDateString(undefined, {
                        weekday: "long",
                        month: "short",
                        day: "numeric",
                      })}
                    </Text>
                  </Pressable>
                  {showStartPicker ? (
                    <DateTimePicker
                      value={startOn}
                      mode="date"
                      display="default"
                      onChange={(event, date) => {
                        setShowStartPicker(false);
                        if (event.type === "set" && date) setStartOn(date);
                      }}
                    />
                  ) : null}
                </>
              )}

              <Text style={styles.formLabel}>{t("How often")}</Text>
              <View style={styles.pipRow}>
                {CADENCES.map((option) => {
                  const active = cadence === option.value;
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => setCadence(option.value)}
                      style={[styles.pip, active && styles.pipActive]}
                    >
                      <Text style={[styles.pipText, active && styles.pipTextActive]}>
                        {t(option.label)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <Text style={styles.formLabel}>{t("Category")}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={styles.pipRow}>
                  {CATEGORIES.map((option) => {
                    const active = category === option;
                    return (
                      <Pressable
                        key={option}
                        onPress={() => setCategory(option)}
                        style={[styles.pip, styles.pipWide, active && styles.pipActive]}
                      >
                        <Text style={[styles.pipText, active && styles.pipTextActive]}>
                          {t(option)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </ScrollView>

              {accounts.length > 1 ? (
                <>
                  <Text style={styles.formLabel}>{t("Account")}</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <View style={styles.pipRow}>
                      {accounts.map((row) => {
                        const active = accountId === row.account.id;
                        return (
                          <Pressable
                            key={row.account.id}
                            onPress={() => setAccountId(row.account.id)}
                            style={[styles.pip, styles.pipWide, active && styles.pipActive]}
                          >
                            <Text
                              style={[styles.pipText, active && styles.pipTextActive]}
                            >
                              {row.account.name}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </ScrollView>
                </>
              ) : null}

              <Text style={styles.hint}>
                {t("The first entry appears the next time Orbi updates your finances.")}
              </Text>
            </View>
          ) : null}

          {rules === null ? (
            <ActivityIndicator color={colors.accent} style={styles.loader} />
          ) : rules.length === 0 && !adding ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>{t("Nothing recurring yet")}</Text>
              <Text style={styles.emptyBody}>
                {t("Most of a month is the same handful of things. Add them once and they'll record themselves.")}
              </Text>
              <Pressable onPress={() => setAdding(true)} style={styles.emptyBtn}>
                <Text style={styles.emptyBtnText}>{t("Add the first one")}</Text>
              </Pressable>
            </View>
          ) : (
            rules.map((rule) => (
              <Pressable
                key={rule.id}
                onLongPress={() => onDelete(rule)}
                style={[styles.card, !rule.active && styles.cardInactive]}
              >
                <View style={styles.cardTop}>
                  <Text style={styles.cardName} numberOfLines={1}>
                    {rule.merchant}
                  </Text>
                  <Text style={styles.cardAmount}>
                    {formatMoney(rule.amount, rule.currency)}
                  </Text>
                </View>
                <View style={styles.cardBottom}>
                  <Text style={styles.cardMeta}>
                    {describeCadence(rule, t)} · {t(rule.category)}
                  </Text>
                  <Switch
                    value={rule.active}
                    onValueChange={() => onToggleActive(rule)}
                    trackColor={{ false: colors.line, true: colors.accent }}
                  />
                </View>
                {/* Tappable: a rule created on the wrong day used to be
                    stuck on it for ever, since nothing here could edit the
                    date and deleting the rule was the only way out. */}
                {rule.active ? (
                  <Pressable
                    onPress={() => setEditingDate(rule)}
                    hitSlop={8}
                    style={styles.nextRow}
                  >
                    <Text style={styles.cardNext}>
                      {t("Next: {date}", { date: rule.next_run_on })}
                    </Text>
                    <MaterialIcons name="edit-calendar" size={14} color={colors.accent} />
                  </Pressable>
                ) : (
                  <Text style={styles.cardNext}>{t("Paused")}</Text>
                )}
              </Pressable>
            ))
          )}

          {error ? <Text style={styles.error}>{error}</Text> : null}
          {rules && rules.length > 0 ? (
            <Text style={styles.footHint}>{t("Long-press a rule to delete it.")}</Text>
          ) : null}
        </ScrollView>

        {adding ? (
          <ActionBar
            primary={{
              label: t("Add rule"),
              onPress: onAdd,
              disabled: !canAdd,
              busy,
            }}
            secondary={{
              label: t("Cancel"),
              onPress: () => {
                setAdding(false);
                Keyboard.dismiss();
              },
            }}
          />
        ) : (
          <ActionBar
            primary={{ label: t("New membership"), onPress: () => setAdding(true) }}
          />
        )}

        {/* Rendered outside the list so one picker serves every row. */}
        {editingDate ? (
          <DateTimePicker
            value={new Date(`${editingDate.next_run_on}T12:00:00`)}
            mode="date"
            display={Platform.OS === "ios" ? "spinner" : "default"}
            themeVariant="dark"
            onChange={(event, date) => {
              const rule = editingDate;
              setEditingDate(null);
              if (event.type !== "set" || !date || !rule) return;
              void onChangeNextDate(rule, date);
            }}
          />
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  flex: { flex: 1 },
  body: { padding: 16, paddingBottom: 48, gap: 12 },
  loader: { marginTop: 40 },
  form: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 10,
  },
  formLabel: { color: colors.inkDim, fontSize: 11, fontWeight: "700", letterSpacing: 0.6 },
  input: {
    backgroundColor: colors.canvas,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 11,
    color: colors.ink,
    fontSize: 15,
  },
  mono: { fontVariant: ["tabular-nums"] },
  pipRow: { flexDirection: "row", gap: 8 },
  pip: {
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.canvas,
    alignItems: "center",
  },
  pipWide: { paddingHorizontal: 16 },
  pipActive: { borderColor: colors.accent, backgroundColor: colors.accent },
  pipText: { color: colors.inkDim, fontSize: 13, fontWeight: "600" },
  pipTextActive: { color: colors.canvas },
  btnDisabled: { opacity: 0.5 },
  hint: { color: colors.inkDim, fontSize: 11, lineHeight: 16 },
  empty: { alignItems: "center", paddingVertical: 48, gap: 10 },
  emptyTitle: { color: colors.ink, fontSize: 16, fontWeight: "700" },
  emptyBody: {
    color: colors.inkDim,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    paddingHorizontal: 12,
  },
  emptyBtn: {
    marginTop: 8,
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 10,
    backgroundColor: colors.accent,
  },
  emptyBtnText: { color: colors.canvas, fontSize: 14, fontWeight: "700" },
  card: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 8,
  },
  cardInactive: { opacity: 0.55 },
  cardTop: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  cardName: { color: colors.ink, fontSize: 15, fontWeight: "600", flexShrink: 1 },
  cardAmount: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  cardBottom: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  cardMeta: { color: colors.inkDim, fontSize: 12, flexShrink: 1 },
  nextRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 },
  dateRow: { alignItems: "flex-start", marginBottom: 4 },
  dateBtn: {
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.canvas,
  },
  dateText: { color: colors.ink, fontSize: 14, fontWeight: "600" },
  cardNext: { color: colors.inkDim, fontSize: 11 },
  error: { color: colors.overdue, fontSize: 12 },
  footHint: { color: colors.inkDim, fontSize: 11, textAlign: "center", marginTop: 4 },
});
