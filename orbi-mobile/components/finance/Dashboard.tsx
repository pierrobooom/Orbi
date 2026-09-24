// Spending dashboard — where the money went, and whether that is unusual.
//
// WHY EVERY FIGURE CARRIES A COMPARISON
// "You spent €412 on groceries" is a fact without a meaning. Whether that is
// good, bad or unremarkable depends entirely on what the last few months
// looked like, so nothing here is shown as a bare number when a baseline
// exists. A dashboard that cannot answer "is that a lot?" is a receipt.
//
// And when there is no history, it says so rather than implying stability —
// a first-month user told every category is "unchanged" has been misled by a
// missing value dressed up as a real one.
//
// Drawn with plain Views rather than a charting library. The two shapes here
// are a proportion bar and a column of daily totals; both are a few flex
// boxes, and neither justifies a dependency, its bundle weight, or another
// thing to keep compatible across an Expo upgrade.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import React from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { useT } from "@/i18n";
import { formatCategory } from "@/services/categories";
import type { FinanceDashboard } from "@/services/api";
import { colors } from "@/theme/colors";
import { DISPLAY } from "@/theme/fonts";

// Category colours reuse the cluster palette so the whole app stays visually
// consistent. Assigned by rank, not by name: the biggest slice is always the
// same colour, which makes month-to-month comparison easier than a fixed
// per-category mapping that leaves gaps when a category is absent.
const SLICE_COLORS = [
  colors.work,
  colors.health,
  colors.finance,
  colors.personal,
  colors.home,
  colors.learning,
  "#f9967d",
  "#e056b4",
];

function money(amount: number, currency: string): string {
  const symbol =
    currency === "EUR" ? "€" : currency === "GBP" ? "£" : currency === "USD" ? "$" : "";
  return `${symbol}${amount.toFixed(2)}`;
}

function Delta({ pct }: { pct: number | null | undefined }) {
  const t = useT();
  if (pct == null) {
    return <Text style={styles.deltaNeutral}>{t("no history yet")}</Text>;
  }
  // Rounded to whole percent: a spending comparison is an impression, and
  // "up 23.4%" implies a precision the underlying data does not have.
  const rounded = Math.round(pct);
  if (rounded === 0) return <Text style={styles.deltaNeutral}>{t("about usual")}</Text>;
  const up = rounded > 0;
  return (
    <Text style={[styles.delta, up ? styles.deltaUp : styles.deltaDown]}>
      {up ? "▲" : "▼"} {Math.abs(rounded)}% {up ? t("more than usual") : t("less than usual")}
    </Text>
  );
}

export function Dashboard({
  data,
  currency,
  loading,
}: {
  data: FinanceDashboard | null;
  currency: string;
  loading: boolean;
}) {
  const t = useT();

  if (loading && !data) {
    return <ActivityIndicator color={colors.accent} style={styles.loader} />;
  }
  if (!data || data.entry_count === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>{t("Nothing to show yet")}</Text>
        <Text style={styles.emptyBody}>
          {t("Once this month has some transactions, you'll see where the money went and whether that's unusual for you.")}
        </Text>
      </View>
    );
  }

  const peak = Math.max(...data.daily.map((d) => d.amount), 1);

  return (
    <View style={styles.root}>
      {/* One card for the three numbers that answer one question — "how is
          this month going". They were three boxes, and a screen built of
          boxes makes every figure look equally important: the eye has to
          visit each border before it can compare anything. One card with
          hairline separators reads as a single statement — spent, in, left. */}
      <View style={styles.card}>
        <Text style={styles.cardLabel}>{t("Spent this month")}</Text>
        <Text style={styles.headline}>{money(data.total_spend, currency)}</Text>
        <Delta pct={data.spend_change_pct} />
        {data.average_spend != null ? (
          <Text style={styles.sub}>
            {t("Usually {amount} by now", {
              amount: money(data.average_spend, currency),
            })}
          </Text>
        ) : null}

        <View style={styles.rule} />

        <View style={styles.pairRow}>
          <View style={styles.half}>
            <Text style={styles.cardLabel}>{t("Came in")}</Text>
            <Text style={styles.pairValue}>{money(data.total_income, currency)}</Text>
          </View>
          <View style={styles.pairDivider} />
          <View style={styles.half}>
            <Text style={styles.cardLabel}>{t("Left over")}</Text>
            <Text style={[styles.pairValue, data.net < 0 && styles.negative]}>
              {money(data.net, currency)}
            </Text>
          </View>
        </View>
      </View>

      {/* The proportion bar. One row rather than a pie: comparing angles is
          harder than comparing lengths, and it fits the width of a phone. */}
      {data.categories.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>{t("Where it went")}</Text>
          <View style={styles.bar}>
            {data.categories.map((c, i) => (
              <View
                key={c.category}
                style={{
                  flex: Math.max(c.share_pct, 1),
                  backgroundColor: SLICE_COLORS[i % SLICE_COLORS.length],
                }}
              />
            ))}
          </View>

          {data.categories.map((c, i) => (
            <View key={c.category} style={styles.legendRow}>
              <View
                style={[
                  styles.dot,
                  { backgroundColor: SLICE_COLORS[i % SLICE_COLORS.length] },
                ]}
              />
              <View style={styles.legendText}>
                <Text style={styles.legendName}>{formatCategory(c.category)}</Text>
                <Delta pct={c.change_pct} />
              </View>
              <View style={styles.legendAmounts}>
                <Text style={styles.legendAmount}>{money(c.amount, currency)}</Text>
                <Text style={styles.legendShare}>{Math.round(c.share_pct)}%</Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {data.top_merchants.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>{t("Most spent with")}</Text>
          {data.top_merchants.map((m) => (
            <View key={m.merchant} style={styles.merchantRow}>
              <Text style={styles.merchantName} numberOfLines={1}>
                {m.merchant}
              </Text>
              <Text style={styles.merchantCount}>
                {m.count === 1 ? t("once") : t("{n} times", { n: m.count })}
              </Text>
              <Text style={styles.merchantAmount}>{money(m.amount, currency)}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* Daily columns, empty days included — a quiet week then a big
          Saturday is the shape worth seeing, and dropping the zeroes would
          smooth it away. */}
      <View style={styles.card}>
        <Text style={styles.cardLabel}>{t("Day by day")}</Text>
        <View style={styles.chart}>
          {data.daily.map((d) => (
            <View key={d.date} style={styles.column}>
              <View
                style={[
                  styles.columnFill,
                  {
                    height: `${Math.max((d.amount / peak) * 100, d.amount > 0 ? 4 : 0)}%`,
                  },
                ]}
              />
            </View>
          ))}
        </View>
        <View style={styles.chartAxis}>
          <Text style={styles.axisLabel}>{t("1st")}</Text>
          <Text style={styles.axisLabel}>
            {t("Peak {amount}", { amount: money(peak, currency) })}
          </Text>
          <Text style={styles.axisLabel}>{t("Today")}</Text>
        </View>
      </View>

      {/* Actionable, so it earns a place. Everything else here is read-only. */}
      {data.uncategorised_count > 0 ? (
        <View style={[styles.card, styles.nudge]}>
          <MaterialIcons name="label-outline" size={18} color={colors.accent} />
          <Text style={styles.nudgeText}>
            {t("{n} transactions have no category. Tap one in Movements to sort it — the rest of this gets sharper as you do.", {
              n: data.uncategorised_count,
            })}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { padding: 16, gap: 12 },
  loader: { marginTop: 48 },
  empty: { alignItems: "center", paddingVertical: 56, paddingHorizontal: 28, gap: 10 },
  emptyTitle: { color: colors.ink, fontSize: 16, fontWeight: "700" },
  emptyBody: {
    color: colors.inkDim,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
  },
  card: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
  },
  cardLabel: {
    color: colors.inkDim,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  // The one serif on the screen. It is the answer the page exists to give,
  // so it gets the typeface with character; everything around it stays in
  // the system font and gets out of the way. No fontWeight: the family name
  // already names the weight, and setting one as well makes iOS go looking
  // for a bold variant of a font that has only this one.
  headline: {
    color: colors.ink,
    fontFamily: DISPLAY,
    fontSize: 44,
    letterSpacing: -1,
    lineHeight: 50,
    fontVariant: ["tabular-nums"],
  },
  sub: { color: colors.inkDim, fontSize: 12, marginTop: 6 },
  delta: { fontSize: 12, fontWeight: "700", marginTop: 6 },
  deltaUp: { color: colors.overdue },
  deltaDown: { color: colors.health },
  deltaNeutral: { color: colors.inkDim, fontSize: 12, marginTop: 6 },
  pairRow: { flexDirection: "row", alignItems: "flex-start" },
  half: { flex: 1 },
  // Hairlines, not borders. They separate without enclosing, which is the
  // whole difference between one card with parts and three cards.
  rule: { height: 1, backgroundColor: colors.line, marginVertical: 16 },
  pairDivider: { width: 1, alignSelf: "stretch", backgroundColor: colors.line, marginHorizontal: 18 },
  pairValue: {
    color: colors.ink,
    fontSize: 19,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  negative: { color: colors.overdue },
  bar: {
    flexDirection: "row",
    height: 12,
    borderRadius: 6,
    overflow: "hidden",
    marginBottom: 14,
    gap: 2,
  },
  legendRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 7,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { flex: 1 },
  legendName: { color: colors.ink, fontSize: 14, fontWeight: "500" },
  legendAmounts: { alignItems: "flex-end" },
  legendAmount: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  legendShare: { color: colors.inkDim, fontSize: 11 },
  merchantRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 7,
  },
  merchantName: { color: colors.ink, fontSize: 14, flex: 1 },
  merchantCount: { color: colors.inkDim, fontSize: 11 },
  merchantAmount: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
    minWidth: 70,
    textAlign: "right",
  },
  chart: {
    flexDirection: "row",
    alignItems: "flex-end",
    height: 90,
    gap: 2,
  },
  column: { flex: 1, height: "100%", justifyContent: "flex-end" },
  columnFill: { backgroundColor: colors.accent, borderRadius: 2, width: "100%" },
  chartAxis: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 8,
  },
  axisLabel: { color: colors.inkDim, fontSize: 10 },
  nudge: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  nudgeText: { color: colors.inkDim, fontSize: 12, lineHeight: 18, flex: 1 },
});
