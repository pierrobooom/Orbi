// Spending limits — a ceiling per category, and a nudge before you hit it.
//
// The limits themselves have existed in the database since the first
// migration and nothing ever read them. A limit that is never checked is a
// note to self, so this screen and the hourly sweep behind it are what turn
// one into a feature.
//
// WHY THE BAR IS THE WHOLE DESIGN
// The only question anyone asks a budget is "how much is left?". A number on
// its own does not answer that at a glance — €140 of €200 needs arithmetic —
// where a bar that is 70% full is read instantly and in peripheral vision.
// The numbers stay underneath for when the exact figure matters.
//
// Alerts fire twice at most per category per month: once at the user's
// threshold, once if the limit is actually passed. That restraint is
// enforced server-side; this screen only says it is happening, so nobody
// wonders whether they are about to be pestered hourly.

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
  deleteLimit,
  getLimits,
  upsertLimit,
  type SpendingLimit,
} from "@/services/api";
import { formatCategory } from "@/services/categories";
import { colors } from "@/theme/colors";

const CATEGORIES = [
  "groceries",
  "dining",
  "transport",
  "subscriptions",
  "shopping",
  "health",
  "home",
  "finance",
];

function money(amount: number, currency = "EUR"): string {
  const symbol = currency === "EUR" ? "€" : currency === "GBP" ? "£" : "$";
  return `${symbol}${amount.toFixed(2)}`;
}

/** Green under the threshold, amber approaching it, red past the limit.
 *
 * Three states rather than a gradient: a gradient looks considered and tells
 * you nothing, because nobody can read "slightly more orange than last week"
 * as a number. The thresholds are the same ones the alerts fire on, so the
 * colour and the notification always agree. */
function barColor(fraction: number | null, threshold: number): string {
  if (fraction == null) return colors.line;
  if (fraction >= 1) return colors.overdue;
  if (fraction >= threshold) return colors.finance;
  return colors.health;
}

export default function LimitsScreen() {
  const t = useT();
  const router = useRouter();

  const [limits, setLimits] = useState<SpendingLimit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const [category, setCategory] = useState(CATEGORIES[0]);
  const [amount, setAmount] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await getLimits();
      setLimits(result.limits);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setLimits((current) => current ?? []);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const used = new Set((limits ?? []).map((l) => l.category));
  const available = CATEGORIES.filter((c) => !used.has(c));

  // The category actually saved, forced to one that is on screen.
  //
  // `category` starts at CATEGORIES[0] — groceries — which drops out of
  // `available` the moment it has a limit. That left no pip highlighted and
  // the state still pointing at groceries, so typing an amount and saving
  // quietly OVERWROTE the groceries limit instead of creating the one the
  // user was looking at. The limit they thought they made never existed,
  // and one they had already set changed behind them.
  //
  // Derived rather than corrected in an effect: state that disagrees with
  // what is rendered is the bug itself, so there should be no moment where
  // the two can differ.
  const effectiveCategory = available.includes(category)
    ? category
    : available[0];

  const parsed = Number(amount.replace(",", "."));
  const canAdd =
    Number.isFinite(parsed) && parsed > 0 && !busy && Boolean(effectiveCategory);

  const onAdd = async () => {
    if (!canAdd) return;
    setBusy(true);
    try {
      await upsertLimit(effectiveCategory, parsed);
      setAmount("");
      setAdding(false);
      Keyboard.dismiss();
      await load();
    } catch (e) {
      Alert.alert(
        translate("Could not save"),
        e instanceof ApiError ? e.message : String(e),
      );
    } finally {
      setBusy(false);
    }
  };

  const onToggleAlerts = async (limit: SpendingLimit) => {
    setLimits((current) =>
      (current ?? []).map((l) =>
        l.id === limit.id ? { ...l, alerts_enabled: !l.alerts_enabled } : l,
      ),
    );
    try {
      await upsertLimit(limit.category, limit.monthly_limit, {
        alerts_enabled: !limit.alerts_enabled,
        alert_threshold: limit.alert_threshold,
      });
    } catch {
      await load();
    }
  };

  const onDelete = (limit: SpendingLimit) => {
    Alert.alert(
      translate("Remove this limit?"),
      translate("Your transactions stay exactly as they are — only the ceiling and its alerts go."),
      [
        { text: translate("Cancel"), style: "cancel" },
        {
          text: translate("Remove"),
          style: "destructive",
          onPress: async () => {
            try {
              await deleteLimit(limit.id);
              await load();
            } catch (e) {
              Alert.alert(
                translate("Could not remove"),
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
        <ScreenHeader title={t("Spending limits")} />

        <ScrollView
          contentContainerStyle={styles.body}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
        >
          {adding ? (
            <View style={styles.form}>
              <Text style={styles.formLabel}>{t("Category")}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={styles.pipRow}>
                  {available.map((option) => {
                    const active = effectiveCategory === option;
                    return (
                      <Pressable
                        key={option}
                        onPress={() => setCategory(option)}
                        style={[styles.pip, active && styles.pipActive]}
                      >
                        <Text style={[styles.pipText, active && styles.pipTextActive]}>
                          {formatCategory(option)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </ScrollView>

              <Text style={styles.formLabel}>{t("Monthly limit")}</Text>
              <TextInput
                value={amount}
                onChangeText={setAmount}
                placeholder="200.00"
                placeholderTextColor={colors.inkDim}
                keyboardType="decimal-pad"
                style={styles.input}
                autoFocus
              />

              <Text style={styles.hint}>
                {t("You'll be told once when you reach 80%, and once if you go over. Never more than that.")}
              </Text>
            </View>
          ) : null}

          {limits === null ? (
            <ActivityIndicator color={colors.accent} style={styles.loader} />
          ) : limits.length === 0 && !adding ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>{t("No limits set")}</Text>
              <Text style={styles.emptyBody}>
                {t("Put a ceiling on a category and Orbi will tell you as you approach it — once, not every hour.")}
              </Text>
              <Pressable onPress={() => setAdding(true)} style={styles.emptyBtn}>
                <Text style={styles.emptyBtnText}>{t("Set the first one")}</Text>
              </Pressable>
            </View>
          ) : (
            limits.map((limit) => {
              const fraction = limit.fraction ?? 0;
              const over = fraction >= 1;
              return (
                <Pressable
                  key={limit.id}
                  onLongPress={() => onDelete(limit)}
                  style={styles.card}
                >
                  <View style={styles.cardTop}>
                    <Text style={styles.cardName}>{formatCategory(limit.category)}</Text>
                    <Text style={[styles.cardRemaining, over && styles.overText]}>
                      {over
                        ? t("{amount} over", { amount: money(Math.abs(limit.remaining)) })
                        : t("{amount} left", { amount: money(limit.remaining) })}
                    </Text>
                  </View>

                  <View style={styles.track}>
                    <View
                      style={[
                        styles.fill,
                        {
                          // Capped at 100% so an overspend does not render as
                          // a bar escaping its container; the red colour and
                          // the "over" figure carry that instead.
                          width: `${Math.min(fraction * 100, 100)}%`,
                          backgroundColor: barColor(limit.fraction, limit.alert_threshold),
                        },
                      ]}
                    />
                  </View>

                  <View style={styles.cardBottom}>
                    <Text style={styles.cardMeta}>
                      {money(limit.spent)} / {money(limit.monthly_limit)}
                    </Text>
                    <View style={styles.alertToggle}>
                      <Text style={styles.cardMeta}>{t("Alerts")}</Text>
                      <Switch
                        value={limit.alerts_enabled}
                        onValueChange={() => onToggleAlerts(limit)}
                        trackColor={{ false: colors.line, true: colors.accent }}
                      />
                    </View>
                  </View>
                </Pressable>
              );
            })
          )}

          {error ? <Text style={styles.error}>{error}</Text> : null}
          {limits && limits.length > 0 ? (
            <Text style={styles.footHint}>{t("Long-press a limit to remove it.")}</Text>
          ) : null}
        </ScrollView>

        {adding ? (
          <ActionBar
            primary={{
              label: t("Set limit"),
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
            primary={{
              label: t("New limit"),
              onPress: () => setAdding(true),
              // Every category already has one. Disabled rather than hidden:
              // a button that vanishes reads as a bug, where a dimmed one
              // reads as "nothing left to add".
              disabled: available.length === 0,
            }}
          />
        )}
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
  pipRow: { flexDirection: "row", gap: 8 },
  pip: {
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.canvas,
  },
  pipActive: { borderColor: colors.accent, backgroundColor: colors.accent },
  pipText: { color: colors.inkDim, fontSize: 13, fontWeight: "600" },
  pipTextActive: { color: colors.canvas },
  input: {
    backgroundColor: colors.canvas,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 11,
    color: colors.ink,
    fontSize: 16,
    fontVariant: ["tabular-nums"],
  },
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
    gap: 10,
  },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardName: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  cardRemaining: {
    color: colors.inkDim,
    fontSize: 13,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  overText: { color: colors.overdue },
  track: {
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.canvas,
    overflow: "hidden",
  },
  fill: { height: "100%", borderRadius: 4 },
  cardBottom: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cardMeta: { color: colors.inkDim, fontSize: 12, fontVariant: ["tabular-nums"] },
  alertToggle: { flexDirection: "row", alignItems: "center", gap: 8 },
  error: { color: colors.overdue, fontSize: 12 },
  footHint: { color: colors.inkDim, fontSize: 11, textAlign: "center", marginTop: 4 },
});
