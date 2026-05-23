// Money tab — bank-statement style. Current-month total at the top,
// chronological entries underneath, floating + button to add.
//
// Per CLAUDE.md: weekly + monthly reports and budget anomaly detection
// land in Pro+; this view stays simple and ledger-shaped for every tier.

import { useRouter, type Href } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useFinanceStore } from "@/stores/financeStore";
import { colors } from "@/theme/colors";
import type { ServerFinanceEntry } from "@/services/api";

interface Section {
  title: string;
  data: ServerFinanceEntry[];
}

function groupByDay(entries: ServerFinanceEntry[]): Section[] {
  const map = new Map<string, ServerFinanceEntry[]>();
  for (const e of entries) {
    if (!map.has(e.entry_date)) map.set(e.entry_date, []);
    map.get(e.entry_date)!.push(e);
  }
  return Array.from(map.entries()).map(([date, data]) => ({
    title: formatSectionDate(date),
    data,
  }));
}

function formatSectionDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const local = new Date(Date.UTC(y, m - 1, d));
  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const diffDays = Math.round((todayUtc.getTime() - local.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return local.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

function formatAmount(amount: number, currency: string): string {
  // Intl.NumberFormat would be nicer but RN/Hermes lacks full ICU on
  // some platforms; this is good enough for GBP-default usage.
  const symbol = currency === "GBP" ? "£" : currency === "EUR" ? "€" : currency === "USD" ? "$" : "";
  return `${symbol}${amount.toFixed(2)}`;
}

function formatMonth(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  if (!y || !m) return monthKey;
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export default function MoneyScreen() {
  const router = useRouter();
  const status = useFinanceStore((s) => s.status);
  const month = useFinanceStore((s) => s.month);
  const entries = useFinanceStore((s) => s.entries);
  const summary = useFinanceStore((s) => s.summary);
  const errorMessage = useFinanceStore((s) => s.errorMessage);
  const hydrate = useFinanceStore((s) => s.hydrate);

  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await hydrate();
    } finally {
      setRefreshing(false);
    }
  }, [hydrate]);

  const sections = groupByDay(entries);
  const totalSpend = summary?.total_spend ?? 0;
  const currency = entries[0]?.currency ?? "GBP";

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerMonth}>{formatMonth(month)}</Text>
          <Text style={styles.headerSubtitle}>Spent this month</Text>
        </View>
        <Text style={styles.headerTotal}>{formatAmount(totalSpend, currency)}</Text>
      </View>

      {status === "loading" || status === "idle" ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : status === "error" ? (
        <View style={styles.centered}>
          <Text style={styles.errorTitle}>Could not load entries</Text>
          <Text style={styles.errorBody}>{errorMessage ?? "Unknown error"}</Text>
          <Pressable onPress={() => hydrate()} style={styles.retryBtn}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : entries.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>No expenses yet</Text>
          <Text style={styles.emptyBody}>
            Tap the + button to log your first one.
          </Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => (
            <Text style={styles.sectionHeader}>{section.title}</Text>
          )}
          renderItem={({ item }) => (
            <EntryRow
              entry={item}
              onPress={() =>
                router.push({
                  pathname: "/entry-detail",
                  params: { id: item.id },
                })
              }
            />
          )}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.accent}
            />
          }
        />
      )}

      <Pressable
        onPress={() => router.push("/new-expense" as Href)}
        style={styles.fab}
        hitSlop={8}
        accessibilityLabel="Add expense"
      >
        <Text style={styles.fabPlus}>+</Text>
      </Pressable>
    </SafeAreaView>
  );
}

function EntryRow({ entry, onPress }: { entry: ServerFinanceEntry; onPress: () => void }) {
  const isExpense = entry.entry_type === "expense";
  return (
    <Pressable onPress={onPress} style={styles.row} android_ripple={{ color: colors.line }}>
      <View style={styles.rowLeft}>
        <Text style={styles.merchant} numberOfLines={1}>
          {entry.merchant}
        </Text>
        <Text style={styles.category}>{entry.category}</Text>
      </View>
      <Text style={[styles.amount, !isExpense && styles.income]}>
        {isExpense ? "-" : "+"}
        {formatAmount(entry.amount, entry.currency)}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    paddingHorizontal: 22,
    paddingTop: 10,
    paddingBottom: 18,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  headerMonth: { color: colors.ink, fontSize: 14, fontWeight: "600" },
  headerSubtitle: { color: colors.inkDim, fontSize: 11, marginTop: 2 },
  headerTotal: { color: colors.ink, fontSize: 26, fontWeight: "700" },
  centered: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  errorTitle: { color: colors.overdue, fontSize: 15, fontWeight: "600", marginBottom: 6 },
  errorBody: { color: colors.inkDim, fontSize: 12, textAlign: "center", marginBottom: 16 },
  retryBtn: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 999,
    borderColor: colors.line,
    borderWidth: 1,
  },
  retryText: { color: colors.ink, fontSize: 13, fontWeight: "600" },
  emptyTitle: { color: colors.ink, fontSize: 17, fontWeight: "600", marginBottom: 6 },
  emptyBody: { color: colors.inkDim, fontSize: 13, textAlign: "center", lineHeight: 19 },
  listContent: { paddingBottom: 100 },
  sectionHeader: {
    color: colors.inkDim,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    paddingHorizontal: 22,
    paddingTop: 18,
    paddingBottom: 8,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 22,
    paddingVertical: 12,
  },
  rowLeft: { flex: 1, marginRight: 12 },
  merchant: { color: colors.ink, fontSize: 15, fontWeight: "500" },
  category: { color: colors.inkDim, fontSize: 12, marginTop: 2 },
  amount: { color: colors.ink, fontSize: 16, fontWeight: "700" },
  income: { color: colors.health },
  separator: { height: 1, backgroundColor: colors.line, marginLeft: 22 },
  fab: {
    position: "absolute",
    right: 22,
    bottom: 22,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  fabPlus: { color: "white", fontSize: 28, fontWeight: "300", marginTop: -2 },
});
