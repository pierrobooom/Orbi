// Vendors — where the money actually went.
//
// The dashboard shows the top few of each, because a summary that lists
// everything is not a summary. This is the other half: every vendor and every
// category for the month, for when the question is "how much have I actually
// spent at X this month".
//
// Two views of the same total. Vendors answer "who did I pay", categories
// answer "what for" — and the same €40 appears in both, which is why the
// total sits above the toggle rather than inside either list.
//
// The bar behind each row is proportional to the largest row, not to the
// total: at twenty vendors, bars against the total are all slivers and
// convey nothing.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/screen-header";
import { useT } from "@/i18n";
import {
  getSpendingBreakdown,
  listAccounts,
  type SpendingBreakdown,
} from "@/services/api";
import { formatCategory, isUncategorized } from "@/services/categories";
import { colors } from "@/theme/colors";

type View_ = "vendors" | "categories";

function money(amount: number, currency: string): string {
  const symbol =
    currency === "GBP" ? "£" : currency === "EUR" ? "€" : currency === "USD" ? "$" : "";
  return `${symbol}${amount.toFixed(2)}`;
}

export default function BreakdownScreen() {
  const t = useT();
  const router = useRouter();

  const [data, setData] = useState<SpendingBreakdown | null>(null);
  const [currency, setCurrency] = useState("EUR");
  const [view, setView] = useState<View_>("vendors");
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    listAccounts()
      .then((rows) => {
        if (rows[0]) setCurrency(rows[0].account.currency);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getSpendingBreakdown()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const rows =
    view === "vendors"
      ? (data?.vendors ?? []).map((v) => ({
          key: v.name,
          label: v.name,
          sub:
            v.category && !isUncategorized(v.category)
              ? formatCategory(v.category)
              : t("{n} transactions", { n: String(v.count) }),
          amount: v.amount,
          count: v.count,
        }))
      : (data?.categories ?? []).map((c) => ({
          key: c.category,
          label: formatCategory(c.category),
          sub: t("{n} transactions", { n: String(c.count) }),
          amount: c.amount,
          count: c.count,
        }));

  const largest = rows.reduce((max, r) => Math.max(max, r.amount), 0);

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <ScreenHeader title={t("Where it went")} />

      <View style={styles.total}>
        <Text style={styles.totalLabel}>{t("Spent this month")}</Text>
        <Text style={styles.totalValue}>{money(data?.total ?? 0, currency)}</Text>
      </View>

      <View style={styles.toggle}>
        {(["vendors", "categories"] as const).map((key) => {
          const active = view === key;
          return (
            <Pressable
              key={key}
              onPress={() => setView(key)}
              style={[styles.toggleTab, active && styles.toggleTabActive]}
            >
              <Text style={[styles.toggleText, active && styles.toggleTextActive]}>
                {key === "vendors" ? t("Vendors") : t("Categories")}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={() => setReloadToken((v) => v + 1)}
            tintColor={colors.accent}
          />
        }
      >
        {loading && !data ? (
          <ActivityIndicator color={colors.accent} style={styles.loader} />
        ) : rows.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{t("Nothing spent this month")}</Text>
            <Text style={styles.emptyBody}>
              {t("Movements you log or import will be broken down here.")}
            </Text>
          </View>
        ) : (
          rows.map((row) => (
            <View key={row.key} style={styles.row}>
              <View
                style={[
                  styles.bar,
                  { width: `${largest > 0 ? (row.amount / largest) * 100 : 0}%` },
                ]}
              />
              <View style={styles.rowContent}>
                <View style={styles.rowLeft}>
                  <Text style={styles.rowLabel} numberOfLines={1}>
                    {row.label}
                  </Text>
                  <Text style={styles.rowSub}>{row.sub}</Text>
                </View>
                <Text style={styles.rowAmount}>{money(row.amount, currency)}</Text>
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  total: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12 },
  totalLabel: { color: colors.inkDim, fontSize: 11 },
  totalValue: {
    color: colors.ink,
    fontSize: 26,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  toggle: { flexDirection: "row", paddingHorizontal: 18, gap: 8, paddingBottom: 12 },
  toggleTab: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
  },
  toggleTabActive: { borderColor: colors.accent, backgroundColor: colors.accent },
  toggleText: { color: colors.inkDim, fontSize: 13, fontWeight: "600" },
  toggleTextActive: { color: colors.canvas },
  body: { padding: 16, paddingBottom: 48, gap: 8 },
  loader: { marginTop: 40 },
  row: {
    borderRadius: 10,
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    overflow: "hidden",
  },
  bar: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: colors.accent,
    opacity: 0.16,
  },
  rowContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rowLeft: { flex: 1, marginRight: 12 },
  rowLabel: { color: colors.ink, fontSize: 14, fontWeight: "600" },
  rowSub: { color: colors.inkDim, fontSize: 11, marginTop: 2 },
  rowAmount: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  empty: { alignItems: "center", paddingTop: 60, paddingHorizontal: 24, gap: 6 },
  emptyTitle: { color: colors.ink, fontSize: 16, fontWeight: "600" },
  emptyBody: { color: colors.inkDim, fontSize: 13, textAlign: "center", lineHeight: 19 },
});
