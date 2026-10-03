// The collection screen's month: what was due, what came in, from whom and
// when — for this month, and any month before it with the arrows.
//
// One card answers the questions a landlord actually asks: "did everyone
// pay September?", "how much is still missing?", "when did Rui pay?".
// A month is the month the money is FOR: Marta's rent paid on 5 October
// for September counts in September — the row shows the real dates.
// Totals on top, then one line per person, then (this month only) what is
// still owed from earlier months, so an unpaid September does not quietly
// disappear on the 1st of October.

import Feather from "@expo/vector-icons/Feather";
import React, { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { Eyebrow, kit, money, monthName, monthTitle, MoneyText, ProgressBar, shortDate } from "@/components/collection/kit";
import { methodLabel } from "@/components/collection/routine-hero";
import { useT } from "@/i18n";
import type { MonthItem, MoneyTotals } from "@/services/api";
import { colors } from "@/theme/colors";
import { themed } from "@/theme/themed";

/** How many rows show before "Show all" — a pet collection can have many. */
const FIRST_ROWS = 6;

interface Props {
  month: string;
  isCurrent: boolean;
  totals: { income: MoneyTotals; expense: MoneyTotals } | null;
  items: MonthItem[] | null;
  owed: MonthItem[];
  canOlder: boolean;
  canNewer: boolean;
  onOlder: () => void;
  onNewer: () => void;
  onToday: () => void;
  onOpen: (item: MonthItem) => void;
}

export function MonthCard(p: Props) {
  const t = useT();
  const [showAll, setShowAll] = useState(false);
  const loading = !p.totals || !p.items;
  const income = p.totals?.income;
  const expense = p.totals?.expense;
  const main = income && income.count > 0 ? income : expense && expense.count > 0 ? expense : null;
  const receiving = main === income;
  // A second line only when a collection both receives and pays (rent in,
  // condomínio out): mixing the two into one number would mean nothing.
  const other = main === income && expense && expense.count > 0 ? expense : null;
  const items = p.items ?? [];
  const shown = showAll ? items : items.slice(0, FIRST_ROWS);
  const owedLate = p.owed.some((i) => i.late_days > 0);

  return (
    <>
      <View style={[kit.card, styles.card]}>
        <View style={styles.nav}>
          <Arrow icon="chevron-left" enabled={p.canOlder} onPress={p.onOlder} label={t("Previous month")} />
          <Pressable onPress={p.onToday} disabled={p.isCurrent} style={styles.navTitle} hitSlop={6}>
            <Text style={styles.monthText}>{monthTitle(p.month)}</Text>
            {!p.isCurrent ? <Text style={styles.backToday}>{t("back to this month")}</Text> : null}
          </Pressable>
          <Arrow icon="chevron-right" enabled={p.canNewer} onPress={p.onNewer} label={t("Next month")} />
        </View>

        {loading ? (
          <ActivityIndicator color={colors.inkDim} style={styles.loading} />
        ) : main ? (
          <>
            <View style={styles.totalRow}>
              <MoneyText size={34}>{money(main.paid)}</MoneyText>
              <Text style={styles.totalOf}>
                {receiving
                  ? t("of {total} received", { total: money(main.target) })
                  : t("of {total} paid", { total: money(main.target) })}
              </Text>
            </View>
            <ProgressBar pct={main.pct} />
            <View style={[kit.row, styles.foot]}>
              <Text style={styles.footText}>
                {t("{done} of {count} paid", { done: main.done, count: main.count })}
              </Text>
              <View style={kit.flex} />
              {main.late > 0 ? (
                <Text style={styles.footLate}>{main.late === 1 ? t("1 late") : t("{n} late", { n: main.late })}</Text>
              ) : main.done === main.count ? (
                <Text style={styles.footOk}>{t("All paid")} ✓</Text>
              ) : null}
            </View>
            {other ? (
              <Text style={styles.other}>
                {t("Expenses: {paid} of {total} paid", { paid: money(other.paid), total: money(other.target) })}
              </Text>
            ) : null}
          </>
        ) : null}

        {!loading && items.length > 0 ? (
          <View style={styles.list}>
            {shown.map((item, i) => (
              <PeriodRow key={item.id} item={item} divider={i > 0} onPress={() => p.onOpen(item)} />
            ))}
            {items.length > FIRST_ROWS ? (
              <Pressable onPress={() => setShowAll(!showAll)} style={styles.more} hitSlop={6}>
                <Text style={styles.moreText}>
                  {showAll ? t("Show less") : t("Show all {n}", { n: items.length })}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {!loading && items.length === 0 ? (
          <Text style={styles.empty}>{t("Nothing was due in {month}.", { month: monthName(p.month, true) })}</Text>
        ) : null}
      </View>

      {p.isCurrent && p.owed.length > 0 ? (
        <>
          {/* Red only when something here is actually late — September's
              arrears rent due on the 5th is open, not owed. */}
          <Eyebrow style={owedLate ? styles.owedLabel : undefined}>{t("Still open from earlier months")}</Eyebrow>
          <View style={[kit.card, owedLate && kit.cardLate]}>
            {p.owed.map((item, i) => (
              <PeriodRow key={item.id} item={item} owed divider={i > 0} onPress={() => p.onOpen(item)} />
            ))}
          </View>
        </>
      ) : null}
    </>
  );
}

function Arrow({ icon, enabled, onPress, label }: {
  icon: "chevron-left" | "chevron-right"; enabled: boolean; onPress: () => void; label: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!enabled}
      hitSlop={8}
      style={[styles.arrow, !enabled && styles.arrowOff]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Feather name={icon} size={18} color={colors.ink} />
    </Pressable>
  );
}

/** One period: who, what for, how much of how much, and when it was paid. */
function PeriodRow({ item, owed = false, divider, onPress }: {
  item: MonthItem; owed?: boolean; divider: boolean; onPress: () => void;
}) {
  const t = useT();
  const closed = Boolean(item.completed_at);
  const skipped = item.closed_reason === "skipped";
  const late = item.late_days > 0;
  const isAmount = item.kind === "amount";

  const who = item.person || item.name || item.title;
  // Rows are grouped by the month they are for, so only the carried-over
  // list needs to name it: "Renda de setembro".
  const what = owed
    ? t("{title} of {month}", { title: item.title, month: monthName(item.ref_month, true) })
    : item.title;
  const where = [item.person ? item.name : null, item.place].filter(Boolean).join(" · ");

  const last = item.payments[item.payments.length - 1];
  let status: string;
  let tone: "ok" | "late" | "dim" | "warn";
  if (skipped) {
    status = t("Skipped");
    tone = "dim";
  } else if (closed) {
    const when = last ? last.paid_on : item.completed_at!.slice(0, 10);
    status = isAmount ? t("Paid {date}", { date: shortDate(when) }) : t("Done {date}", { date: shortDate(when) });
    if (item.paid_late_days > 0) {
      status += ` · ${item.paid_late_days === 1 ? t("1 day late") : t("{n} days late", { n: item.paid_late_days })}`;
      tone = "warn";
    } else {
      tone = "ok";
    }
  } else if (late) {
    status = item.late_days === 1 ? t("1 day late") : t("{n} days late", { n: item.late_days });
    tone = "late";
  } else {
    status = t("Due {date}", { date: shortDate(item.period_on) });
    tone = "dim";
  }

  // Every payment, with its date and how: "30 set · €200 · Dinheiro". One
  // full payment is already said by "Paid 3 Oct", so it is not repeated.
  const listPayments = isAmount && item.payments.length > 0 && !(closed && item.payments.length === 1);

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, divider && styles.divider, pressed && styles.pressed]}>
      <View style={[styles.dot, tone === "ok" && styles.dotOk, tone === "late" && styles.dotLate,
        tone === "warn" && styles.dotWarn, !closed && !late && item.pct > 0 && styles.dotPart]} />
      <View style={kit.flex}>
        <View style={kit.row}>
          <Text style={styles.who} numberOfLines={1}>{who}</Text>
          <View style={kit.flex} />
          {isAmount ? (
            <Text style={styles.amount}>
              {closed || item.pct === 0
                ? money(closed && !skipped ? item.paid : item.amount, item.currency)
                : t("{paid} of {total}", { paid: money(item.paid, item.currency), total: money(item.amount, item.currency) })}
            </Text>
          ) : null}
        </View>
        <Text style={styles.what} numberOfLines={1}>{[what, where].filter(Boolean).join(" · ")}</Text>
        <Text style={[styles.status, tone === "ok" && styles.ok, tone === "late" && styles.lateText,
          tone === "warn" && styles.warn]}>
          {status}
        </Text>
        {listPayments
          ? item.payments.map((pay) => (
            <Text key={pay.id} style={styles.payment}>
              {[shortDate(pay.paid_on), money(pay.amount, item.currency), methodLabel(pay.method)]
                .filter(Boolean).join(" · ")}
            </Text>
          ))
          : null}
      </View>
      <Feather name="chevron-right" size={16} color={colors.faint} style={styles.chev} />
    </Pressable>
  );
}

const styles = themed(() => StyleSheet.create({
  card: { marginTop: 14 },
  nav: { flexDirection: "row", alignItems: "center", marginBottom: 6 },
  navTitle: { flex: 1, alignItems: "center" },
  monthText: { color: colors.ink, fontSize: 15, fontWeight: "800", textTransform: "capitalize" },
  backToday: { color: colors.inkDim, fontSize: 11.5, textDecorationLine: "underline", marginTop: 1 },
  arrow: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
  },
  arrowOff: { opacity: 0.25 },
  loading: { marginVertical: 24 },
  totalRow: { flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", marginTop: 4 },
  totalOf: { color: colors.inkDim, fontSize: 13, marginLeft: 8 },
  foot: { marginTop: 9 },
  footText: { color: colors.inkDim, fontSize: 12 },
  footLate: { color: colors.overdue, fontSize: 12, fontWeight: "700" },
  footOk: { color: colors.health, fontSize: 12, fontWeight: "700" },
  other: { color: colors.inkDim, fontSize: 12, marginTop: 6 },
  list: { marginTop: 12, borderTopWidth: 1, borderTopColor: colors.line },
  row: { flexDirection: "row", alignItems: "flex-start", paddingVertical: 10, gap: 10 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  pressed: { opacity: 0.6 },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 5, borderWidth: 1.5, borderColor: colors.faint },
  dotOk: { backgroundColor: colors.health, borderColor: colors.health },
  dotLate: { borderColor: colors.overdue, backgroundColor: colors.overdue },
  dotWarn: { backgroundColor: colors.health, borderColor: colors.health, opacity: 0.6 },
  dotPart: { borderColor: colors.health },
  who: { color: colors.ink, fontSize: 14.5, fontWeight: "800", flexShrink: 1 },
  amount: { color: colors.ink, fontSize: 13.5, fontWeight: "700", marginLeft: 8 },
  what: { color: colors.inkDim, fontSize: 12.5, marginTop: 1 },
  status: { color: colors.inkDim, fontSize: 12.5, marginTop: 3, fontWeight: "600" },
  ok: { color: colors.health },
  lateText: { color: colors.overdue, fontWeight: "700" },
  warn: { color: colors.inkDim },
  payment: { color: colors.inkDim, fontSize: 12, marginTop: 2 },
  chev: { marginTop: 3 },
  more: { alignSelf: "center", paddingTop: 6, paddingBottom: 2 },
  moreText: { color: colors.inkDim, fontSize: 12.5, fontWeight: "700", textDecorationLine: "underline" },
  empty: { color: colors.inkDim, fontSize: 13.5, marginTop: 8, marginBottom: 4 },
  owedLabel: { color: colors.overdue },
}));
