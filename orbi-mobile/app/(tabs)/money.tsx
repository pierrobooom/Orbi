// Money — the hub.
//
// This used to be a single scrolling ledger doing four jobs at once: showing
// transactions, totalling the month, hiding the accounts behind a small link,
// and having nowhere at all to put limits or insights. Every new idea made it
// worse, because a ledger has no room for anything that is not a transaction.
//
// So the tab is a menu now, and each block owns one question:
//
//   Accounts   — what do I have, and what moved
//   Insights   — what is worth noticing
//   Dashboard  — what does it add up to
//   Vendors    — where exactly did it go
//   Recurring  — what is going to happen again
//
// The header keeps the one number worth seeing without tapping anything: what
// is in the accounts, and what has been spent this month. Everything else is
// one tap away rather than scrolled past.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useFocusEffect, useRouter, type Href } from "expo-router";
import React, { useCallback, useState } from "react";
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

import { SettingsButton } from "@/components/settings-button";
import { useT } from "@/i18n";
import {
  connectionsNeedingAttention,
  getFinanceDashboard,
  listAccounts,
  type AccountBalance,
  type BankConnection,
  type FinanceDashboard,
} from "@/services/api";
import { useFinanceStore } from "@/stores/financeStore";
import { colors } from "@/theme/colors";

interface Block {
  key: string;
  href: string;
  icon: keyof typeof MaterialIcons.glyphMap;
  label: string;
  /** One line under the label. Answers "why would I tap this" — a grid of
   * bare icons makes the user guess, and they guess wrong. */
  hint: string;
}

function money(amount: number, currency: string): string {
  const symbol =
    currency === "EUR" ? "€" : currency === "GBP" ? "£" : currency === "USD" ? "$" : "";
  return `${symbol}${amount.toFixed(2)}`;
}

function formatMonth(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  if (!y || !m) return monthKey;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

export default function MoneyScreen() {
  const t = useT();
  const router = useRouter();

  const month = useFinanceStore((s) => s.month);
  const summary = useFinanceStore((s) => s.summary);
  const status = useFinanceStore((s) => s.status);
  const hydrate = useFinanceStore((s) => s.hydrate);

  const [accounts, setAccounts] = useState<AccountBalance[]>([]);
  const [dashboard, setDashboard] = useState<FinanceDashboard | null>(null);
  const [attention, setAttention] = useState<BankConnection[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    await hydrate();
    // Both are allowed to fail quietly: the hub still works without them,
    // and an error banner over a menu is noise the user cannot act on.
    listAccounts()
      .then(setAccounts)
      .catch(() => setAccounts([]));
    getFinanceDashboard()
      .then(setDashboard)
      .catch(() => setDashboard(null));
    connectionsNeedingAttention()
      .then(setAttention)
      .catch(() => setAttention([]));
  }, [hydrate]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const currency = accounts[0]?.account.currency ?? "EUR";
  const balance = accounts
    .filter((a) => a.account.include_in_total)
    .reduce((sum, a) => sum + a.balance, 0);
  const spent = summary?.total_spend ?? 0;

  const blocks: Block[] = [
    {
      key: "accounts",
      href: "/accounts",
      icon: "account-balance",
      label: t("Accounts"),
      hint: t("Balances and movements"),
    },
    {
      key: "insights",
      href: "/insights",
      icon: "auto-awesome",
      label: t("Insights"),
      hint: t("What's worth noticing"),
    },
    {
      key: "dashboard",
      href: "/spending",
      icon: "pie-chart",
      label: t("Dashboard"),
      hint: t("Where the money went"),
    },
    {
      key: "vendors",
      href: "/breakdown",
      icon: "storefront",
      label: t("Vendors"),
      hint: t("Spend by shop and category"),
    },
    {
      key: "recurring",
      href: "/recurring",
      icon: "autorenew",
      label: t("Memberships"),
      hint: t("Subscriptions and repeats"),
    },
    {
      key: "limits",
      href: "/limits",
      icon: "speed",
      label: t("Limits"),
      hint: t("Ceilings per category"),
    },
    {
      key: "categories",
      href: "/categories",
      icon: "label",
      label: t("Categories"),
      hint: t("Make them fit your life"),
    },
    // Last, and wide: the ledger is still here for anyone who wants to read
    // it straight through, but it is no longer what the tab opens on.
    {
      key: "movements",
      href: "/movements",
      icon: "receipt-long",
      label: t("All movements"),
      hint: t("Every transaction this month"),
    },
  ];

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accent}
          />
        }
      >
        <View style={styles.titleRow}>
          <Text style={styles.title}>{t("Money")}</Text>
          <SettingsButton />
        </View>

        {/* Two numbers, because they answer different questions and people
            conflate them: what you HAVE, and what you have SPENT. The old
            header showed only the second while looking like the first. */}
        <View style={styles.summary}>
          <View style={styles.summaryHalf}>
            <Text style={styles.summaryLabel}>{t("Across accounts")}</Text>
            {status === "loading" && accounts.length === 0 ? (
              <ActivityIndicator color={colors.inkDim} style={styles.summaryLoader} />
            ) : (
              <Text style={styles.summaryValue}>{money(balance, currency)}</Text>
            )}
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryHalf}>
            <Text style={styles.summaryLabel}>
              {t("Spent in {month}", { month: formatMonth(month) })}
            </Text>
            <Text style={styles.summaryValue}>{money(spent, currency)}</Text>
            {dashboard?.spend_change_pct != null ? (
              <Text
                style={[
                  styles.summaryDelta,
                  dashboard.spend_change_pct > 0 ? styles.up : styles.down,
                ]}
              >
                {dashboard.spend_change_pct > 0 ? "▲" : "▼"}{" "}
                {Math.abs(Math.round(dashboard.spend_change_pct))}%{" "}
                {t("vs usual")}
              </Text>
            ) : null}
          </View>
        </View>

        {/* Directly under the totals, because it is about those totals.
            A lapsed bank consent makes the number above quietly incomplete,
            and the user has no way to see that from the number itself — it
            looks like a quiet month. This is the only thing allowed to
            interrupt the menu. */}
        {attention.length > 0 ? (
          <Pressable
            onPress={() => router.push("/accounts" as Href)}
            style={styles.alert}
          >
            <MaterialIcons name="link-off" size={18} color={colors.overdue} />
            <View style={styles.alertBody}>
              <Text style={styles.alertTitle}>
                {attention.length === 1
                  ? t("A bank connection needs attention")
                  : t("{n} bank connections need attention", {
                      n: String(attention.length),
                    })}
              </Text>
              <Text style={styles.alertText}>
                {t("Totals may be missing recent transactions. Tap to reconnect.")}
              </Text>
            </View>
            <MaterialIcons name="chevron-right" size={20} color={colors.inkDim} />
          </Pressable>
        ) : null}

        <View style={styles.grid}>
          {blocks.map((block) => (
            <Pressable
              key={block.key}
              onPress={() => router.push(block.href as Href)}
              style={styles.block}
              android_ripple={{ color: colors.line }}
            >
              <View style={styles.blockIcon}>
                <MaterialIcons name={block.icon} size={24} color={colors.accent} />
              </View>
              <Text style={styles.blockLabel}>{block.label}</Text>
              <Text style={styles.blockHint} numberOfLines={2}>
                {block.hint}
              </Text>
            </Pressable>
          ))}
        </View>

        <Pressable
          onPress={() => router.push("/new-expense" as Href)}
          style={styles.addBtn}
        >
          <MaterialIcons name="add" size={20} color={colors.canvas} />
          <Text style={styles.addBtnText}>{t("Log an expense")}</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  body: { padding: 16, paddingBottom: 48 },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  title: { color: colors.ink, fontSize: 22, fontWeight: "800" },
  summary: {
    flexDirection: "row",
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    marginBottom: 16,
  },
  summaryHalf: { flex: 1 },
  summaryDivider: { width: 1, backgroundColor: colors.line, marginHorizontal: 14 },
  summaryLabel: {
    color: colors.inkDim,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  summaryValue: {
    color: colors.ink,
    fontSize: 22,
    fontWeight: "800",
    marginTop: 5,
    fontVariant: ["tabular-nums"],
  },
  summaryLoader: { alignSelf: "flex-start", marginTop: 8 },
  summaryDelta: { fontSize: 11, fontWeight: "600", marginTop: 4 },
  up: { color: colors.overdue },
  down: { color: colors.health },
  alert: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 14,
    marginBottom: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.overdue,
    backgroundColor: colors.panel,
  },
  alertBody: { flex: 1 },
  alertTitle: { color: colors.ink, fontSize: 13, fontWeight: "700" },
  alertText: { color: colors.inkDim, fontSize: 11, lineHeight: 16, marginTop: 2 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  block: {
    // Two per row on any phone, without hard-coding a width.
    width: "47.5%",
    flexGrow: 1,
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 20,
    paddingHorizontal: 16,
    minHeight: 132,
  },
  blockIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: colors.canvas,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  blockLabel: { color: colors.ink, fontSize: 15, fontWeight: "700" },
  blockHint: { color: colors.inkDim, fontSize: 11, lineHeight: 15, marginTop: 3 },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 20,
    paddingVertical: 15,
    borderRadius: 12,
    backgroundColor: colors.accent,
  },
  addBtnText: { color: colors.canvas, fontSize: 15, fontWeight: "700" },
});
