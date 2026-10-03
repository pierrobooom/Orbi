// Screen 6 of the Collections mockups: record money towards this period.
//
// Opened from the room screen and from a reminder's "Recebi parte…". Part
// or all of it: one tap on "Falta €400" completes the month, and the card
// underneath says what this payment will do before it is saved.

import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Switch } from "@/components/switch";
import { TextInput } from "@/components/text-input";

import { DateField } from "@/components/collection/date-field";
import { kit, money, monthName, parseAmount, ProgressBar, todayIso } from "@/components/collection/kit";
import { dismissDeliveredFor } from "@/hooks/useNotificationActions";
import { useT } from "@/i18n";
import {
  ApiError,
  getRoutine,
  recordPayment,
  updateRoutine,
  type PaymentMethod,
  type RoutineDetail,
} from "@/services/api";
import { cue } from "@/services/feedback";
import { useUniverseStore } from "@/stores/universeStore";
import { colors } from "@/theme/colors";
import { DISPLAY } from "@/theme/fonts";
import { themed } from "@/theme/themed";

const METHODS: PaymentMethod[] = ["mbway", "transfer", "cash"];
const METHOD_WORD: Record<string, string> = { mbway: "MB Way", transfer: "Transfer", cash: "Cash" };

export default function PayScreen() {
  const t = useT();
  const router = useRouter();
  const { routine: routineId } = useLocalSearchParams<{ routine: string }>();
  const [data, setData] = useState<RoutineDetail | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("mbway");
  const [paidOn, setPaidOn] = useState(todayIso());
  const [logToMoney, setLogToMoney] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<TextInput>(null);

  useEffect(() => {
    getRoutine(String(routineId))
      .then((d) => {
        setData(d);
        setLogToMoney(d.routine.log_to_finance);
        const p = d.routine.current;
        if (p) {
          const left = Math.max(Number(p.amount ?? 0) - Number(p.paid), 0);
          setAmount(String(Number.isInteger(left) ? left : left.toFixed(2)));
        }
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : t("Could not load this.")));
  }, [routineId, t]);

  const period = data?.routine.current ?? null;
  const total = Number(period?.amount ?? 0);
  const paid = Number(period?.paid ?? 0);
  const left = Math.max(total - paid, 0);
  const value = parseAmount(amount);
  const after = total > 0 && Number.isFinite(value) ? Math.min(100, Math.round(((paid + value) / total) * 100)) : 0;
  const lastPayment = period?.payments[period.payments.length - 1];
  const firstChip = useMemo(() => {
    const suggestion = lastPayment ? Number(lastPayment.amount) : Math.round(total / 3);
    return suggestion > 0 && suggestion < left ? suggestion : null;
  }, [lastPayment, total, left]);

  if (!data || !period) {
    return (
      <View style={[kit.screen, kit.centered]}>
        {error ? <Text style={kit.error}>{error}</Text> : <ActivityIndicator color={colors.inkDim} />}
      </View>
    );
  }

  const currency = data.routine.currency;
  const who = data.resource?.person_name;
  const sub = [data.resource?.name, who, monthName(period.ref_month ?? period.period_on, true)].filter(Boolean).join(" · ");

  const toggleMoney = (on: boolean) => {
    setLogToMoney(on);
    // A property of the routine, not of this one payment: the next payment
    // should not need the switch flipped again.
    updateRoutine(data.routine.id, { log_to_finance: on }).catch(() => setLogToMoney(!on));
  };

  const save = async () => {
    if (!Number.isFinite(value) || value <= 0) {
      setError(t("Enter an amount."));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await recordPayment(period.id, value.toFixed(2), method, paidOn);
      if (paid + value >= total) {
        cue("complete");
        if (period.task_id) await dismissDeliveredFor(period.task_id);
      }
      void useUniverseStore.getState().hydrate();
      router.back();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("Could not save. Try again."));
      setBusy(false);
    }
  };

  const chip = (label: string, on: boolean, onPress: () => void) => (
    <Pressable onPress={onPress} style={[styles.chip, on && styles.chipOn]} accessibilityRole="button">
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );

  return (
    // A standard modal sheet (see app/_layout.tsx): the scroll view insets
    // itself for the keyboard, so the field being typed in stays visible.
    <View style={kit.screen}>
      <View style={styles.grabber} />
      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets
      >
        <Text style={styles.title}>{t("Record payment")}</Text>
        <Text style={kit.sub}>{sub}</Text>

        <TextInput
          ref={input}
          value={amount ? `${currency === "EUR" ? "€" : ""}${amount}` : ""}
          onChangeText={(v) => setAmount(v.replace(/[^\d,.]/g, ""))}
          keyboardType="decimal-pad"
          style={styles.amount}
          placeholder={money(0, currency)}
          placeholderTextColor={colors.faint}
          selectTextOnFocus
        />
        <View style={styles.chips}>
          {firstChip ? chip(money(firstChip, currency), value === firstChip, () => setAmount(String(firstChip))) : null}
          {chip(t("Left {amount}", { amount: money(left, currency) }), value === left, () =>
            setAmount(String(Number.isInteger(left) ? left : left.toFixed(2))))}
          {chip(t("Other"), false, () => { setAmount(""); input.current?.focus(); })}
        </View>

        <Text style={styles.label}>{t("How")}</Text>
        <View style={styles.seg}>
          {METHODS.map((m) => (
            <Pressable key={m} onPress={() => setMethod(m)} style={[styles.segItem, method === m && styles.segOn]}>
              <Text style={[styles.segText, method === m && styles.segTextOn]}>{t(METHOD_WORD[m])}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.label}>{t("When")}</Text>
        <DateField value={paidOn} onChange={setPaidOn} />

        <View style={[kit.row, styles.toggle]}>
          <Text style={styles.toggleText}>{t("Also record in Money")}</Text>
          <View style={kit.flex} />
          <Switch value={logToMoney} onValueChange={toggleMoney} trackColor={{ true: colors.health }} />
        </View>

        {Number.isFinite(value) && value > 0 ? (
          <View style={[kit.card, styles.preview, after >= 100 && styles.previewDone]}>
            <View style={kit.row}>
              <Text style={[styles.previewText, after >= 100 && styles.previewTextDone]}>
                {t("With this payment: {pct}%", { pct: after })}{after >= 100 ? " ✓" : ""}
              </Text>
              <View style={kit.flex} />
              {after >= 100 ? (
                <Text style={styles.previewSide}>{t("{month} closed", { month: monthName(period.ref_month ?? period.period_on, true) })}</Text>
              ) : null}
            </View>
            <ProgressBar pct={after} />
          </View>
        ) : null}

        {error ? <Text style={kit.error}>{error}</Text> : null}
        <Pressable style={[kit.primaryBtn, styles.save]} onPress={save} disabled={busy} accessibilityRole="button">
          {busy ? <ActivityIndicator color={colors.canvas} /> : <Text style={kit.primaryText}>{t("Save")}</Text>}
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = themed(() => StyleSheet.create({
  body: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 30, flexGrow: 1 },
  // The sheet's handle, drawn here now that the system one is not used.
  grabber: {
    alignSelf: "center",
    width: 36,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.faint,
    marginTop: 8,
  },
  title: { color: colors.ink, fontSize: 20, fontWeight: "800" },
  amount: {
    color: colors.ink,
    fontFamily: DISPLAY,
    fontSize: 54,
    textAlign: "center",
    marginTop: 16,
    marginBottom: 6,
    paddingVertical: 0,
  },
  chips: { flexDirection: "row", justifyContent: "center", gap: 8 },
  chip: { backgroundColor: colors.line, borderRadius: 999, paddingHorizontal: 13, paddingVertical: 7 },
  chipOn: { backgroundColor: colors.accent },
  chipText: { color: colors.inkDim, fontSize: 13, fontWeight: "700" },
  chipTextOn: { color: colors.canvas },
  label: {
    color: colors.inkDim,
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 0.9,
    textTransform: "uppercase",
    marginTop: 18,
    marginBottom: 6,
  },
  seg: { flexDirection: "row", backgroundColor: colors.line, borderRadius: 12, padding: 3, gap: 2 },
  segItem: { flex: 1, alignItems: "center", paddingVertical: 9, borderRadius: 10 },
  segOn: { backgroundColor: colors.panel },
  segText: { color: colors.inkDim, fontSize: 13, fontWeight: "600" },
  segTextOn: { color: colors.ink },
  toggle: { marginTop: 16 },
  toggleText: { color: colors.ink, fontSize: 14 },
  preview: { marginTop: 16 },
  previewDone: { backgroundColor: "rgba(21,128,61,0.08)", borderColor: "rgba(21,128,61,0.25)" },
  previewText: { color: colors.ink, fontSize: 13.5, fontWeight: "700" },
  previewTextDone: { color: colors.health },
  previewSide: { color: colors.health, fontSize: 12.5 },
  save: { marginTop: 18 },
}));
