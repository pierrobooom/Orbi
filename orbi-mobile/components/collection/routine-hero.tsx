// The top of the room screen (mockup screen 5), shared with the routine
// screen: the ring for this period, what is paid of what, when it is due,
// the two buttons, this period's payments and the months before it.

import { useRouter, type Href } from "expo-router";
import React, { useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";

import {
  Chip,
  daysUntil,
  Eyebrow,
  kit,
  lateText,
  money,
  monthName,
  MoneyText,
  ProgressRing,
  shortDate,
} from "@/components/collection/kit";
import { dismissDeliveredFor } from "@/hooks/useNotificationActions";
import { translate, useT } from "@/i18n";
import {
  ApiError,
  deletePayment,
  settlePeriod,
  updateTask,
  type CollectionRoutine,
  type PaymentMethod,
  type RoutinePeriod,
} from "@/services/api";
import { cue } from "@/services/feedback";
import { useUniverseStore } from "@/stores/universeStore";
import { colors } from "@/theme/colors";
import { themed } from "@/theme/themed";

const METHOD_LABEL: Record<PaymentMethod, string> = {
  mbway: "MB Way",
  transfer: "Transfer",
  cash: "Cash",
  card: "Card",
  other: "Other",
};

/** The month a period is for: its own, or the one before when the
 * routine is paid in arrears (Marta's 5 October rent is September's). */
export function forMonth(p: Pick<RoutinePeriod, "period_on" | "ref_month">): string {
  return p.ref_month ?? p.period_on;
}

export function methodLabel(m: PaymentMethod | null): string {
  return m ? translate(METHOD_LABEL[m]) : "";
}

interface Props {
  routine: CollectionRoutine;
  onChanged: () => void;
}

export function RoutineHero({ routine, onChanged }: Props) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const period = routine.current;
  const isOpen = Boolean(period && !period.completed_at);
  const isAmount = routine.kind === "amount";
  const pct = period ? (period.completed_at && !isAmount ? 100 : period.pct) : 0;

  const settle = async () => {
    if (!period || busy) return;
    setBusy(true);
    setError(null);
    try {
      await settlePeriod(period.id);
      cue("complete");
      if (period.task_id) await dismissDeliveredFor(period.task_id);
      void useUniverseStore.getState().hydrate();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("Could not save. Try again."));
    } finally {
      setBusy(false);
    }
  };

  // A finished period can always be taken back — ticked by mistake, or
  // marked paid when it was not. Reopening goes through its bubble: the
  // server then removes the payment that finishing it recorded (manual
  // payments stay), and the trigger reopens the period.
  const reopen = () => {
    if (!period?.task_id) return;
    Alert.alert(
      t("Reopen this period?"),
      t("It goes back to open. Payments you recorded yourself are kept."),
      [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Reopen"),
          onPress: async () => {
            try {
              await updateTask(period.task_id!, { status: "active" });
              void useUniverseStore.getState().hydrate();
              onChanged();
            } catch (e) {
              setError(e instanceof ApiError ? e.message : t("Could not save. Try again."));
            }
          },
        },
      ],
    );
  };

  const removePayment = (paymentId: string, amount: string) => {
    Alert.alert(
      t("Delete this payment?"),
      t("{amount} will no longer count towards this period.", { amount: money(amount, routine.currency) }),
      [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Delete"),
          style: "destructive",
          onPress: async () => {
            try {
              await deletePayment(paymentId);
              void useUniverseStore.getState().hydrate();
              onChanged();
            } catch (e) {
              setError(e instanceof ApiError ? e.message : t("Could not save. Try again."));
            }
          },
        },
      ],
    );
  };

  return (
    <View>
      <View style={styles.ringWrap}>
        <ProgressRing pct={pct}>
          <MoneyText size={30}>{isAmount || isOpen ? `${pct}%` : "✓"}</MoneyText>
          {period ? (
            <Text style={styles.ringSub}>{t("of {month}", { month: monthName(forMonth(period), true) })}</Text>
          ) : null}
        </ProgressRing>
        {isAmount && period ? (
          <Text style={styles.amounts}>
            {t("{paid} of {total}", {
              paid: money(period.paid, routine.currency),
              total: money(period.amount, routine.currency),
            })}
          </Text>
        ) : null}
        <StatusLine routine={routine} period={period} />
      </View>

      {isOpen ? (
        <View style={styles.buttons}>
          {isAmount ? (
            <Pressable
              style={[kit.primaryBtn, styles.grow]}
              onPress={() => router.push(`/collection/pay?routine=${routine.id}` as Href)}
              accessibilityRole="button"
            >
              <Text style={kit.primaryText} numberOfLines={1}>
                {t(routine.direction === "income" ? "Record payment" : "Record a payment")}
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            style={[isAmount ? kit.secondaryBtn : kit.primaryBtn, isAmount ? styles.side : styles.grow]}
            onPress={settle}
            disabled={busy}
            accessibilityRole="button"
          >
            {busy ? (
              <ActivityIndicator color={isAmount ? colors.ink : colors.canvas} />
            ) : (
              <Text style={isAmount ? kit.secondaryText : kit.primaryText}>
                {isAmount ? `${t("Paid")} ✓` : t("Mark as done")}
              </Text>
            )}
          </Pressable>
        </View>
      ) : null}
      {period?.completed_at && period.closed_reason !== "skipped" && period.task_id ? (
        <Pressable onPress={reopen} style={styles.reopen} hitSlop={8} accessibilityRole="button">
          <Text style={styles.reopenText}>{t("Reopen")}</Text>
        </Pressable>
      ) : null}
      {error ? <Text style={kit.error}>{error}</Text> : null}

      {isAmount && period && period.payments.length > 0 ? (
        <>
          <Eyebrow>{t("Payments for {month}", { month: monthName(forMonth(period), true) })}</Eyebrow>
          <View style={kit.card}>
            {period.payments.map((p, i) => (
              <Pressable
                key={p.id}
                onLongPress={() => removePayment(p.id, p.amount)}
                delayLongPress={400}
                style={[styles.payRow, i > 0 && styles.payDivider]}
                accessibilityHint={t("Press and hold to delete")}
              >
                <Text style={styles.payDate}>{shortDate(p.paid_on)}</Text>
                <Text style={styles.payMethod}>{methodLabel(p.method)}</Text>
                <View style={kit.flex} />
                <Text style={styles.payAmount}>{money(p.amount, routine.currency)}</Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}

      <History routine={routine} />
    </View>
  );
}

function StatusLine({ routine, period }: { routine: CollectionRoutine; period: RoutinePeriod | null }) {
  const t = useT();
  if (!period) {
    return routine.next_on ? (
      <Text style={styles.status}>{t("Next: {date}", { date: shortDate(routine.next_on) })}</Text>
    ) : null;
  }
  if (period.completed_at) {
    const word = period.closed_reason === "skipped" ? t("Skipped")
      : routine.kind === "amount" ? t("Paid") : t("Done");
    return (
      <Text style={[styles.status, styles.statusOk]}>
        {`✓ ${word}`}{routine.next_on ? ` · ${t("next {date}", { date: shortDate(routine.next_on) })}` : ""}
      </Text>
    );
  }
  if (routine.state === "late") {
    return <Text style={[styles.status, styles.statusLate]}>{t("Late {days}", { days: lateText(routine.late_days) })}</Text>;
  }
  const n = daysUntil(period.period_on);
  const left = n <= 0 ? t("today") : n === 1 ? t("tomorrow") : t("{n} days left", { n });
  // Arrears: the ring already says "of September"; "due 5 Oct" under it
  // then needs no further explanation.
  return (
    <Text style={styles.status}>
      {t("Due {date}", { date: shortDate(period.period_on) })} · {left}
    </Text>
  );
}

function History({ routine }: { routine: CollectionRoutine }) {
  const t = useT();
  const past = (routine.history ?? []).filter((p) => p.id !== routine.current?.id || p.completed_at);
  if (past.length <= 1 && !routine.history?.some((p) => p.completed_at)) return null;
  return (
    <>
      <Eyebrow>{t("Previous periods")}</Eyebrow>
      <View style={styles.history}>
        {(routine.history ?? []).map((p) => {
          const label = monthName(forMonth(p));
          if (p.completed_at && p.closed_reason !== "skipped") {
            return <Chip key={p.id} tone="ok" label={`${label} ✓`} />;
          }
          if (p.closed_reason === "skipped") return <Chip key={p.id} tone="soon" label={`${label} –`} />;
          if (daysUntil(p.period_on) < 0) return <Chip key={p.id} tone="late" label={label} />;
          return (
            <View key={p.id} style={styles.openChip}>
              <Text style={styles.openChipText}>
                {routine.kind === "amount" ? `${label} ${p.pct}%` : label}
              </Text>
            </View>
          );
        })}
      </View>
    </>
  );
}

const styles = themed(() => StyleSheet.create({
  ringWrap: { alignItems: "center", marginTop: 14 },
  ringSub: { color: colors.inkDim, fontSize: 11.5, marginTop: 1 },
  amounts: { color: colors.ink, fontSize: 15, fontWeight: "700", marginTop: 8 },
  status: { color: colors.inkDim, fontSize: 13.5, marginTop: 2 },
  statusLate: { color: colors.overdue, fontWeight: "700" },
  statusOk: { color: colors.health, fontWeight: "700" },
  buttons: { flexDirection: "row", gap: 10, marginTop: 16 },
  grow: { flex: 1.6 },
  side: { flex: 1 },
  payRow: { flexDirection: "row", alignItems: "center", paddingVertical: 4 },
  payDivider: { borderTopWidth: 1, borderTopColor: colors.line, marginTop: 6, paddingTop: 10 },
  payDate: { color: colors.ink, fontSize: 14, fontWeight: "700" },
  payMethod: { color: colors.inkDim, fontSize: 13.5, marginLeft: 10 },
  payAmount: { color: colors.ink, fontSize: 14, fontWeight: "700" },
  history: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  reopen: { alignSelf: "center", marginTop: 10, paddingVertical: 4, paddingHorizontal: 8 },
  reopenText: { color: colors.inkDim, fontSize: 13.5, fontWeight: "700", textDecorationLine: "underline" },
  openChip: {
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  openChipText: { color: colors.ink, fontSize: 11.5, fontWeight: "700" },
}));
