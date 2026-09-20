// Money tab — bank-statement style. Current-month total at the top,
// chronological entries underneath, floating + button to add.
//
// Per CLAUDE.md: weekly + monthly reports and budget anomaly detection
// land in Pro+; this view stays simple and ledger-shaped for every tier.

import { useFocusEffect, useRouter, type Href } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { translate, useT } from "@/i18n";
import { formatCategory, isUncategorized } from "@/services/categories";
import { useFinanceStore } from "@/stores/financeStore";
import { colors } from "@/theme/colors";
import {
  getFinanceDashboard,
  listAccounts,
  type AccountBalance,
  type FinanceDashboard,
  type ServerFinanceEntry,
} from "@/services/api";
import { Dashboard } from "@/components/finance/Dashboard";

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
  if (diffDays === 0) return translate("Today");
  if (diffDays === 1) return translate("Yesterday");
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
  const t = useT();
  const router = useRouter();
  const status = useFinanceStore((s) => s.status);
  const month = useFinanceStore((s) => s.month);
  const entries = useFinanceStore((s) => s.entries);
  const summary = useFinanceStore((s) => s.summary);
  const errorMessage = useFinanceStore((s) => s.errorMessage);
  const hydrate = useFinanceStore((s) => s.hydrate);

  const [refreshing, setRefreshing] = useState(false);
  const [accounts, setAccounts] = useState<AccountBalance[]>([]);
  // null means "every account". Kept local: it is a way of looking at the
  // data, not a setting worth persisting to the server.
  const [accountFilter, setAccountFilter] = useState<string | null>(null);
  const [section, setSection] = useState<"movements" | "dashboard">("movements");
  const [dashboard, setDashboard] = useState<FinanceDashboard | null>(null);

  // Refetch whenever the tab is focused, not just once on mount.
  //
  // A tab screen stays mounted for the life of the app, so a plain useEffect
  // fired exactly once and never again. Anything that arrived afterwards — a
  // bank sync, a recurring rule, an entry added from another screen — was
  // invisible until the whole app was restarted, which is precisely how it
  // was reported.
  useFocusEffect(
    useCallback(() => {
      void hydrate();
      // Balances live on the accounts endpoint, not in the entries store,
      // and the filter row needs them to label each account with what is
      // actually in it. Failure is silent: no accounts just means no filter
      // row, which is the correct look for someone who never made one.
      listAccounts()
        .then(setAccounts)
        .catch(() => setAccounts([]));
    }, [hydrate]),
  );

  // Fetched separately from the entries, and re-fetched when the account
  // filter changes: the dashboard compares against several months of
  // history, which the month-scoped entries store does not hold.
  useEffect(() => {
    let cancelled = false;
    getFinanceDashboard(undefined, accountFilter)
      .then((d) => {
        if (!cancelled) setDashboard(d);
      })
      .catch(() => {
        if (!cancelled) setDashboard(null);
      });
    return () => {
      cancelled = true;
    };
  }, [accountFilter, entries.length]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await hydrate();
    } finally {
      setRefreshing(false);
    }
  }, [hydrate]);

  const visible = accountFilter
    ? entries.filter((e) => e.account_id === accountFilter)
    : entries;
  const sections = groupByDay(visible);

  // With a filter on, the month total has to be recomputed from the visible
  // rows — the server's summary covers every account, so showing it beside a
  // single account's list would caption the wrong number.
  const totalSpend = accountFilter
    ? visible
        .filter((e) => e.entry_type === "expense")
        .reduce((sum, e) => sum + e.amount, 0)
    : summary?.total_spend ?? 0;
  const currency = visible[0]?.currency ?? accounts[0]?.account.currency ?? "EUR";

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerMonth}>{formatMonth(month)}</Text>
          <Text style={styles.headerSubtitle}>{t("Spent this month")}</Text>
        </View>
        <View style={styles.headerRight}>
          <Text style={styles.headerTotal}>{formatAmount(totalSpend, currency)}</Text>
          <Pressable
            onPress={() => router.push("/accounts" as Href)}
            hitSlop={10}
            style={styles.accountsLink}
            accessibilityLabel="Accounts"
          >
            <Text style={styles.accountsLinkText}>{t("Accounts")}</Text>
          </Pressable>
        </View>
      </View>

      {/* Which account these entries belong to.
          The header total is money SPENT this month, which is a different
          number from what is IN an account — and with several accounts the
          list silently mixed them, so neither figure described anything the
          user could point at. Filtering makes the question explicit. */}
      {accounts.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          <Pressable
            onPress={() => setAccountFilter(null)}
            style={[styles.filterPip, accountFilter === null && styles.filterPipActive]}
          >
            <Text
              style={[
                styles.filterText,
                accountFilter === null && styles.filterTextActive,
              ]}
            >
              {t("All accounts")}
            </Text>
          </Pressable>
          {accounts.map((row) => {
            const active = accountFilter === row.account.id;
            return (
              <Pressable
                key={row.account.id}
                onPress={() => setAccountFilter(row.account.id)}
                style={[styles.filterPip, active && styles.filterPipActive]}
              >
                <Text style={[styles.filterText, active && styles.filterTextActive]}>
                  {row.account.name}
                </Text>
                <Text style={[styles.filterBalance, active && styles.filterTextActive]}>
                  {formatAmount(row.balance, row.account.currency)}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      {/* Movements and Dashboard answer different questions about the same
          data — "what happened" versus "what does it add up to" — and a
          single scrolling ledger was being asked to do both. */}
      <View style={styles.sectionRow}>
        {(["movements", "dashboard"] as const).map((key) => {
          const active = section === key;
          return (
            <Pressable
              key={key}
              onPress={() => setSection(key)}
              style={[styles.sectionTab, active && styles.sectionTabActive]}
            >
              <Text style={[styles.sectionText, active && styles.sectionTextActive]}>
                {key === "movements" ? t("Movements") : t("Dashboard")}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {section === "dashboard" ? (
        <ScrollView
          contentContainerStyle={styles.dashboardScroll}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.accent}
            />
          }
        >
          <Dashboard
            data={dashboard}
            currency={currency}
            loading={status === "loading"}
          />
        </ScrollView>
      ) : status === "loading" || status === "idle" ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : status === "error" ? (
        <View style={styles.centered}>
          <Text style={styles.errorTitle}>{t("Could not load entries")}</Text>
          <Text style={styles.errorBody}>{errorMessage ?? "Unknown error"}</Text>
          <Pressable onPress={() => hydrate()} style={styles.retryBtn}>
            <Text style={styles.retryText}>{t("Retry")}</Text>
          </Pressable>
        </View>
      ) : entries.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>{t("No expenses yet")}</Text>
          <Text style={styles.emptyBody}>
            {t("Tap the + button to log your first one.")}
          </Text>
        </View>
      ) : (
        <SectionList
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
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
  const needsCategory = isUncategorized(entry.category);
  return (
    <Pressable onPress={onPress} style={styles.row} android_ripple={{ color: colors.line }}>
      <View style={styles.rowLeft}>
        <Text style={styles.merchant} numberOfLines={1}>
          {entry.merchant}
        </Text>
        {/* An uncategorised entry is a prompt, not a category. Styling it as
            a tappable hint rather than a label stops it reading as a bug and
            tells the user the one thing they can do about it. */}
        <Text style={[styles.category, needsCategory && styles.categoryMissing]}>
          {needsCategory ? translate("Tap to categorise") : formatCategory(entry.category)}
        </Text>
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
  headerRight: { alignItems: "flex-end", gap: 4 },
  accountsLink: { paddingVertical: 2 },
  accountsLinkText: { color: colors.accent, fontSize: 12, fontWeight: "600" },
  filterRow: { paddingHorizontal: 18, paddingBottom: 10, gap: 8 },
  sectionRow: { flexDirection: "row", paddingHorizontal: 18, gap: 8, paddingBottom: 12 },
  sectionTab: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
  },
  sectionTabActive: { borderColor: colors.accent, backgroundColor: colors.accent },
  sectionText: { color: colors.inkDim, fontSize: 13, fontWeight: "600" },
  sectionTextActive: { color: colors.canvas },
  dashboardScroll: { paddingBottom: 90 },
  filterPip: {
    paddingVertical: 7,
    paddingHorizontal: 13,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
    alignItems: "flex-start",
  },
  filterPipActive: { borderColor: colors.accent, backgroundColor: colors.accent },
  filterText: { color: colors.ink, fontSize: 12, fontWeight: "600" },
  filterBalance: { color: colors.inkDim, fontSize: 10, marginTop: 2, fontVariant: ["tabular-nums"] },
  filterTextActive: { color: colors.canvas },
  categoryMissing: { color: colors.accent, fontStyle: "italic" },
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
