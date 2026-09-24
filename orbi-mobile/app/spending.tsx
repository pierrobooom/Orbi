// Dashboard — what the month adds up to.
//
// The Dashboard component was previously a tab inside the ledger, which meant
// a user had to scroll past transactions to reach a summary of them. It gets
// its own screen now for the same reason the hub exists: "what happened" and
// "what does it add up to" are separate questions.
//
// The account filter stays, and re-fetches rather than filtering locally —
// the dashboard compares against several months of history, which the
// month-scoped entries store does not hold.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Dashboard } from "@/components/finance/Dashboard";
import { ScreenHeader } from "@/components/screen-header";
import { useT } from "@/i18n";
import {
  getFinanceDashboard,
  listAccounts,
  type AccountBalance,
  type FinanceDashboard,
} from "@/services/api";
import { colors } from "@/theme/colors";

function formatAmount(amount: number, currency: string): string {
  const symbol =
    currency === "GBP" ? "£" : currency === "EUR" ? "€" : currency === "USD" ? "$" : "";
  return `${symbol}${amount.toFixed(2)}`;
}

export default function SpendingScreen() {
  const t = useT();
  const router = useRouter();

  const [accounts, setAccounts] = useState<AccountBalance[]>([]);
  const [accountFilter, setAccountFilter] = useState<string | null>(null);
  const [data, setData] = useState<FinanceDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  // Bumped by pull-to-refresh; the fetch effect depends on it.
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    listAccounts()
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getFinanceDashboard(undefined, accountFilter)
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
  }, [accountFilter, reloadToken]);

  const currency = accounts[0]?.account.currency ?? "EUR";

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <ScreenHeader title={t("Dashboard")} />

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
              style={[styles.filterText, accountFilter === null && styles.filterTextActive]}
            >
              {/* Short, because a pill is a filter and not a sentence — and
                  the pills beside it already say what the choice is between.
                  The full "All accounts" stays in the Movements dropdown,
                  where it is the only label in view. */}
              {t("All")}
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
        <Dashboard data={data} currency={currency} loading={loading} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  filterRow: { paddingHorizontal: 18, paddingVertical: 12, gap: 8 },
  filterPip: {
    // Asymmetric on purpose. The balance is the last line and its glyph box
    // sits lower than the name's, so equal padding reads as the number being
    // pinned to the border. justifyContent centres the block for the
    // single-line "All accounts" pill, which the horizontal scroller
    // stretches to match its two-line neighbours.
    paddingTop: 8,
    paddingBottom: 10,
    paddingHorizontal: 13,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
    alignItems: "flex-start",
    justifyContent: "center",
  },
  filterPipActive: { borderColor: colors.accent, backgroundColor: colors.accent },
  // Explicit lineHeight on both: without one, small text on iOS gets the
  // bottom of its glyph box trimmed inside a tight container, which is
  // what clipped the balance.
  filterText: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: "600",
    lineHeight: 15,
  },
  filterBalance: {
    color: colors.inkDim,
    fontSize: 10,
    lineHeight: 13,
    marginTop: 3,
    fontVariant: ["tabular-nums"],
  },
  filterTextActive: { color: colors.canvas },
  body: { paddingBottom: 48 },
});
