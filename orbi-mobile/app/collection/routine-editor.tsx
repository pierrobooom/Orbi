// Screen 8 of the Collections mockups: create or edit a routine.
//
// Name, type (tick off, or an amount paid in parts), the amount and whose it
// is, how it repeats, what happens if the day passes, and when to remind.
// The "if the day passes" default follows the rhythm — a daily chore moves
// on, a monthly rent stays owed — until the user picks one themselves.

import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Switch } from "@/components/switch";
import { TextInput } from "@/components/text-input";
import { SafeAreaView } from "react-native-safe-area-context";

import { DateField } from "@/components/collection/date-field";
import { kit, parseAmount, todayIso, TopBar } from "@/components/collection/kit";
import { useT } from "@/i18n";
import {
  ApiError,
  archiveRoutine,
  createRoutine,
  getResource,
  getRoutine,
  updateResource,
  updateRoutine,
  type RoutineFrequency,
  type RoutineInput,
  type RoutineOnMiss,
} from "@/services/api";
import { useUniverseStore } from "@/stores/universeStore";
import { colors } from "@/theme/colors";
import { themed } from "@/theme/themed";

const FREQUENCIES: RoutineFrequency[] = ["daily", "weekly", "monthly", "yearly"];
const FREQ_WORD: Record<RoutineFrequency, string> = {
  daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly",
};
const UNIT_WORD: Record<RoutineFrequency, [string, string]> = {
  daily: ["day", "days"], weekly: ["week", "weeks"], monthly: ["month", "months"], yearly: ["year", "years"],
};
const ON_MISS: RoutineOnMiss[] = ["stay_overdue", "skip_ahead", "from_done"];
const ON_MISS_WORD: Record<RoutineOnMiss, string> = {
  stay_overdue: "Stays overdue",
  skip_ahead: "Moves ahead",
  from_done: "Counts from done",
};

function defaultOnMiss(f: RoutineFrequency): RoutineOnMiss {
  return f === "daily" || f === "weekly" ? "skip_ahead" : "stay_overdue";
}

export default function RoutineEditor() {
  const t = useT();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string; resource?: string }>();
  const editingId = params.id ? String(params.id) : null;

  const [loading, setLoading] = useState(true);
  const [resourceId, setResourceId] = useState<string | null>(params.resource ? String(params.resource) : null);
  const [resourceLabel, setResourceLabel] = useState("");
  const [isUnit, setIsUnit] = useState(false);
  const [person, setPerson] = useState("");
  const [originalPerson, setOriginalPerson] = useState("");

  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"check" | "amount">("amount");
  const [amount, setAmount] = useState("");
  const [direction, setDirection] = useState<"income" | "expense">("income");
  const [frequency, setFrequency] = useState<RoutineFrequency>("monthly");
  const [interval, setIntervalCount] = useState(1);
  const [anchor, setAnchor] = useState(todayIso());
  // Editing shows the next due date, which is not the stored anchor. Sending
  // it back unchanged would read as a new schedule and rebuild the current
  // period, so it is only sent when the user actually moves it.
  const [anchorTouched, setAnchorTouched] = useState(false);
  const [onMiss, setOnMiss] = useState<RoutineOnMiss>("stay_overdue");
  const [onMissTouched, setOnMissTouched] = useState(false);
  const [before, setBefore] = useState<number | null>(3);
  const [onDay, setOnDay] = useState(true);
  const [after, setAfter] = useState<number | null>(1);
  const [logToMoney, setLogToMoney] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        let rid = resourceId;
        if (editingId) {
          const { routine: r } = await getRoutine(editingId);
          rid = r.resource_id;
          setResourceId(rid);
          setTitle(r.title);
          setKind(r.kind);
          setAmount(r.amount ? String(Number(r.amount)) : "");
          setDirection(r.direction);
          setFrequency(r.frequency);
          setIntervalCount(r.interval_count);
          setAnchor(r.current && !r.current.completed_at ? r.current.period_on : r.next_on ?? r.anchor_on);
          setOnMiss(r.on_miss);
          setOnMissTouched(true);
          setBefore(r.remind_before_days);
          setOnDay(r.remind_on_day);
          setAfter(r.remind_after_days);
          setLogToMoney(r.log_to_finance);
        }
        if (rid) {
          const view = await getResource(rid);
          const unit = Boolean(view.resource.parent_id);
          setIsUnit(unit);
          setPerson(view.resource.person_name ?? "");
          setOriginalPerson(view.resource.person_name ?? "");
          setResourceLabel([view.resource.name, view.parent?.name].filter(Boolean).join(" · "));
        }
      } catch (e) {
        setError(e instanceof ApiError ? e.message : t("Could not load this."));
      } finally {
        setLoading(false);
      }
    })();
    // Loaded once for the screen; later changes are the user's own edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickFrequency = (f: RoutineFrequency) => {
    setFrequency(f);
    if (!onMissTouched) setOnMiss(defaultOnMiss(f));
  };

  const save = async () => {
    if (!title.trim()) return setError(t("Give it a name."));
    const value = parseAmount(amount);
    if (kind === "amount" && (!Number.isFinite(value) || value <= 0)) return setError(t("Enter an amount."));
    if (!resourceId) return;
    setBusy(true);
    setError(null);
    const body: RoutineInput = {
      resource_id: resourceId,
      title: title.trim(),
      kind,
      amount: kind === "amount" ? value.toFixed(2) : null,
      direction,
      frequency,
      interval_count: interval,
      anchor_on: anchor,
      on_miss: onMiss,
      remind_before_days: before,
      remind_on_day: onDay,
      remind_after_days: after,
      log_to_finance: kind === "amount" ? logToMoney : false,
    };
    try {
      // The person belongs to the unit (the room's tenant), not to one
      // routine — saved there so every routine of the room shares it.
      if (isUnit && person.trim() !== originalPerson) {
        await updateResource(resourceId, { person_name: person.trim() || null });
      }
      if (editingId) {
        const { resource_id: _r, anchor_on: _a, ...rest } = body;
        await updateRoutine(editingId, anchorTouched ? { ...rest, anchor_on: anchor } : rest);
      } else {
        await createRoutine(body);
      }
      void useUniverseStore.getState().hydrate();
      router.back();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("Could not save. Try again."));
      setBusy(false);
    }
  };

  const archive = () => {
    if (!editingId) return;
    Alert.alert(t("Archive this routine?"), t("Its open periods close, and its history is kept."), [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Archive"),
        style: "destructive",
        onPress: async () => {
          try {
            await archiveRoutine(editingId);
            void useUniverseStore.getState().hydrate();
            router.dismissTo(`/collection/resource/${resourceId}` as Href);
          } catch (e) {
            setError(e instanceof ApiError ? e.message : t("Could not save. Try again."));
          }
        },
      },
    ]);
  };

  if (loading) {
    return (
      <SafeAreaView style={kit.screen}>
        <View style={kit.centered}><ActivityIndicator color={colors.inkDim} /></View>
      </SafeAreaView>
    );
  }

  const seg = <T extends string>(items: T[], value: T, words: Record<T, string>, onPick: (v: T) => void) => (
    <View style={styles.seg}>
      {items.map((it) => (
        <Pressable key={it} onPress={() => onPick(it)} style={[styles.segItem, value === it && styles.segOn]}>
          <Text style={[styles.segText, value === it && styles.segTextOn]} numberOfLines={1}>{t(words[it])}</Text>
        </Pressable>
      ))}
    </View>
  );

  const reminderChip = (label: string, on: boolean, toggle: () => void) => (
    <Pressable onPress={toggle} style={[styles.chip, on && styles.chipOn]} accessibilityRole="switch"
      accessibilityState={{ checked: on }}>
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );

  const [one, many] = UNIT_WORD[frequency];

  return (
    <SafeAreaView style={kit.screen} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <TopBar icon="x" />
        <Pressable onPress={save} disabled={busy} style={styles.saveTop} accessibilityRole="button">
          {busy ? <ActivityIndicator color={colors.ink} /> : <Text style={styles.saveText}>{t("Save")}</Text>}
        </Pressable>
      </View>
      <KeyboardAvoidingView style={kit.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={kit.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>{editingId ? t("Edit routine") : t("New routine")}</Text>
          {resourceLabel ? <Text style={kit.sub}>{resourceLabel}</Text> : null}

          <Text style={styles.label}>{t("Name")}</Text>
          <TextInput value={title} onChangeText={setTitle} style={styles.input} maxLength={60}
            placeholder={t("Rent, vaccine, inspection…")} placeholderTextColor={colors.inkDim} />

          <Text style={styles.label}>{t("Type")}</Text>
          {seg<"check" | "amount">(["check", "amount"], kind, { check: "Mark done", amount: "Amount" }, setKind)}

          {kind === "amount" ? (
            <>
              <View style={styles.pair}>
                <View style={kit.flex}>
                  <Text style={styles.label}>{t("Amount")}</Text>
                  <TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad"
                    style={styles.input} placeholder="€0" placeholderTextColor={colors.inkDim} />
                </View>
                {isUnit ? (
                  <View style={kit.flex}>
                    <Text style={styles.label}>{t("Person")}</Text>
                    <TextInput value={person} onChangeText={setPerson} style={styles.input} maxLength={60}
                      placeholder={t("Who pays")} placeholderTextColor={colors.inkDim} />
                  </View>
                ) : null}
              </View>
              <View style={styles.dirRow}>
                {seg<"income" | "expense">(["income", "expense"], direction,
                  { income: "I receive it", expense: "I pay it" }, setDirection)}
              </View>
            </>
          ) : isUnit ? (
            <>
              <Text style={styles.label}>{t("Person")}</Text>
              <TextInput value={person} onChangeText={setPerson} style={styles.input} maxLength={60}
                placeholderTextColor={colors.inkDim} />
            </>
          ) : null}

          <Text style={styles.label}>{t("Repeats")}</Text>
          {seg(FREQUENCIES, frequency, FREQ_WORD, pickFrequency)}

          <View style={styles.pair}>
            <View style={kit.flex}>
              <Text style={styles.label}>{t("Every")}</Text>
              <View style={[styles.input, styles.stepper]}>
                <Pressable onPress={() => setIntervalCount((n) => Math.max(1, n - 1))} hitSlop={8} style={styles.step}>
                  <Text style={styles.stepText}>−</Text>
                </Pressable>
                <Text style={styles.stepValue}>{interval} {t(interval === 1 ? one : many)}</Text>
                <Pressable onPress={() => setIntervalCount((n) => Math.min(24, n + 1))} hitSlop={8} style={styles.step}>
                  <Text style={styles.stepText}>+</Text>
                </Pressable>
              </View>
            </View>
            <View style={kit.flex}>
              <Text style={styles.label}>{editingId ? t("Next time") : t("First time")}</Text>
              <DateField value={anchor} onChange={(v) => { setAnchor(v); setAnchorTouched(true); }} />
            </View>
          </View>

          <Text style={styles.label}>{t("If the day passes")}</Text>
          {seg(ON_MISS, onMiss, ON_MISS_WORD, (v) => { setOnMiss(v); setOnMissTouched(true); })}
          <Text style={styles.hint}>
            {onMiss === "stay_overdue" ? t("It stays open until it is done — right for money owed.")
              : onMiss === "skip_ahead" ? t("The next one replaces it — right for chores.")
              : t("The next date counts from when it was done — right for vaccines.")}
          </Text>

          <Text style={styles.label}>{t("Remind")}</Text>
          <View style={styles.chips}>
            {reminderChip(before ? t("{n} days before", { n: before }) : t("3 days before"), before !== null,
              () => setBefore(before === null ? 3 : null))}
            {reminderChip(t("on the day"), onDay, () => setOnDay(!onDay))}
            {reminderChip(after ? (after === 1 ? t("1 day after") : t("{n} days after", { n: after })) : t("1 day after"),
              after !== null, () => setAfter(after === null ? 1 : null))}
          </View>

          {kind === "amount" ? (
            <View style={[kit.row, styles.toggle]}>
              <Text style={styles.toggleText}>{t("Also record payments in Money")}</Text>
              <View style={kit.flex} />
              <Switch value={logToMoney} onValueChange={setLogToMoney} trackColor={{ true: colors.health }} />
            </View>
          ) : null}

          {error ? <Text style={kit.error}>{error}</Text> : null}

          {editingId ? (
            <Pressable onPress={archive} style={styles.archive} accessibilityRole="button">
              <Text style={styles.archiveText}>{t("Archive routine")}</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = themed(() => StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center" },
  saveTop: { position: "absolute", right: 20, top: 16, minWidth: 48, alignItems: "flex-end" },
  saveText: { color: colors.ink, fontSize: 15.5, fontWeight: "800" },
  title: { color: colors.ink, fontSize: 23, fontWeight: "800", marginTop: 4 },
  label: {
    color: colors.inkDim,
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 0.9,
    textTransform: "uppercase",
    marginTop: 16,
    marginBottom: 6,
  },
  input: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    minHeight: 46,
    color: colors.ink,
    fontSize: 15,
  },
  pair: { flexDirection: "row", gap: 10 },
  dirRow: { marginTop: 8 },
  seg: { flexDirection: "row", backgroundColor: colors.line, borderRadius: 12, padding: 3, gap: 2 },
  segItem: { flex: 1, alignItems: "center", paddingVertical: 9, borderRadius: 10, paddingHorizontal: 2 },
  segOn: { backgroundColor: colors.panel },
  segText: { color: colors.inkDim, fontSize: 12.5, fontWeight: "600" },
  segTextOn: { color: colors.ink },
  hint: { color: colors.inkDim, fontSize: 12, marginTop: 6, lineHeight: 17 },
  stepper: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  step: { paddingHorizontal: 4, paddingVertical: 6 },
  stepText: { color: colors.ink, fontSize: 20, fontWeight: "600" },
  stepValue: { color: colors.ink, fontSize: 15 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { backgroundColor: colors.line, borderRadius: 999, paddingHorizontal: 13, paddingVertical: 7 },
  chipOn: { backgroundColor: colors.accent },
  chipText: { color: colors.inkDim, fontSize: 13, fontWeight: "700" },
  chipTextOn: { color: colors.canvas },
  toggle: { marginTop: 18 },
  toggleText: { color: colors.ink, fontSize: 14 },
  archive: { alignSelf: "center", marginTop: 26, padding: 10 },
  archiveText: { color: colors.overdue, fontSize: 14, fontWeight: "700" },
}));
