// Movements — the ledger.
//
// This was the whole Money tab until the tab became a hub. Nothing about the
// list changed; it just stopped being the only thing finance could show, and
// stopped pretending its month total described a single account.
//
// Opened either from the hub (every account) or from a row on the Accounts
// screen (one account, via the `account` param). The scope is a dropdown
// that always states what is being shown, and with no filter on, each row
// carries the account it came from — a mixed list where every row looks
// alike cannot answer "which card was that on".
//
// WHY THE TOTAL IS RECOMPUTED WHEN A FILTER IS ON
// The server's summary covers every account. Showing it above one account's
// rows would caption the wrong number with the right heading, which is worse
// than showing nothing — the user has no way to tell it is wrong.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/screen-header";
import { translate, useT } from "@/i18n";
import { listAccounts, type AccountBalance, type ServerFinanceEntry } from "@/services/api";
import { formatCategory, isUncategorized } from "@/services/categories";
import { useFinanceStore } from "@/stores/financeStore";
import { colors } from "@/theme/colors";

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
  const todayUtc = new Date(
    Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()),
  );
  const diffDays = Math.round(
    (todayUtc.getTime() - local.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (diffDays === 0) return translate("Today");
  if (diffDays === 1) return translate("Yesterday");
  return local.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

function formatAmount(amount: number, currency: string): string {
  // Intl.NumberFormat would be nicer but RN/Hermes lacks full ICU on some
  // platforms; this is good enough for our currencies.
  const symbol =
    currency === "GBP" ? "£" : currency === "EUR" ? "€" : currency === "USD" ? "$" : "";
  return `${symbol}${amount.toFixed(2)}`;
}

export default function MovementsScreen() {
  const t = useT();
  const router = useRouter();
  const params = useLocalSearchParams<{ account?: string }>();

  const status = useFinanceStore((s) => s.status);
  const entries = useFinanceStore((s) => s.entries);
  const summary = useFinanceStore((s) => s.summary);
  const errorMessage = useFinanceStore((s) => s.errorMessage);
  const hydrate = useFinanceStore((s) => s.hydrate);

  const [refreshing, setRefreshing] = useState(false);
  const [accounts, setAccounts] = useState<AccountBalance[]>([]);
  // null means "every account". Kept local: it is a way of looking at the
  // data, not a setting worth persisting to the server.
  const [accountFilter, setAccountFilter] = useState<string | null>(
    params.account ?? null,
  );
  const [pickerOpen, setPickerOpen] = useState(false);

  useFocusEffect(
    useCallback(() => {
      void hydrate();
      listAccounts()
        .then(setAccounts)
        .catch(() => setAccounts([]));
    }, [hydrate]),
  );

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

  const totalSpend = accountFilter
    ? visible
        .filter((e) => e.entry_type === "expense")
        .reduce((sum, e) => sum + e.amount, 0)
    : summary?.total_spend ?? 0;
  const currency = visible[0]?.currency ?? accounts[0]?.account.currency ?? "EUR";
  const scopeName = accountFilter
    ? accounts.find((a) => a.account.id === accountFilter)?.account.name
    : null;
  const accountNames = new Map(accounts.map((a) => [a.account.id, a.account.name]));

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <ScreenHeader title={t("Movements")} />

      <View style={styles.total}>
        <Text style={styles.totalLabel}>
          {scopeName
            ? t("Spent this month · {account}", { account: scopeName })
            : t("Spent this month")}
        </Text>
        <Text style={styles.totalValue}>{formatAmount(totalSpend, currency)}</Text>
      </View>

      {/* A dropdown rather than a row of pips.
          The pips were fine at two accounts and stopped being fine at five:
          the row scrolled sideways, so which account was selected could be
          off-screen, and "what am I looking at" is the one question this
          screen must always answer without scrolling. A closed dropdown
          states the current scope in one line. */}
      {accounts.length > 1 ? (
        <Pressable onPress={() => setPickerOpen(true)} style={styles.picker}>
          <View style={styles.pickerLeft}>
            <Text style={styles.pickerLabel}>{t("Showing")}</Text>
            <Text style={styles.pickerValue} numberOfLines={1}>
              {scopeName ?? t("All accounts")}
            </Text>
          </View>
          <MaterialIcons name="expand-more" size={22} color={colors.inkDim} />
        </Pressable>
      ) : null}

      {status === "loading" || status === "idle" ? (
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
      ) : visible.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>{t("Nothing here yet")}</Text>
          <Text style={styles.emptyBody}>
            {accountFilter
              ? t("No movements on this account this month.")
              : t("Tap the + button to log your first one.")}
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
              // Only when several accounts are mixed together. With a filter
              // on, every row carries the same label and it is just noise
              // repeated down the screen.
              accountName={
                accountFilter === null ? accountNames.get(item.account_id ?? "") : undefined
              }
              onPress={() =>
                router.push({ pathname: "/entry-detail", params: { id: item.id } })
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
        onPress={() => router.push("/new-expense")}
        style={styles.fab}
        hitSlop={8}
        accessibilityLabel="Add expense"
      >
        <Text style={styles.fabPlus}>+</Text>
      </Pressable>

      <Modal
        visible={pickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setPickerOpen(false)}
      >
        {/* Tapping the dimmed area closes it — the only way out on Android
            besides the back gesture, and the one people try first. */}
        <Pressable style={styles.sheetBackdrop} onPress={() => setPickerOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <Text style={styles.sheetTitle}>{t("Show movements from")}</Text>

            <AccountOption
              label={t("All accounts")}
              detail={formatAmount(
                accounts
                  .filter((a) => a.account.include_in_total)
                  .reduce((sum, a) => sum + a.balance, 0),
                currency,
              )}
              selected={accountFilter === null}
              onPress={() => {
                setAccountFilter(null);
                setPickerOpen(false);
              }}
            />
            {accounts.map((row) => (
              <AccountOption
                key={row.account.id}
                label={row.account.name}
                detail={formatAmount(row.balance, row.account.currency)}
                selected={accountFilter === row.account.id}
                onPress={() => {
                  setAccountFilter(row.account.id);
                  setPickerOpen(false);
                }}
              />
            ))}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function AccountOption({
  label,
  detail,
  selected,
  onPress,
}: {
  label: string;
  detail: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.option, selected && styles.optionSelected]}
      android_ripple={{ color: colors.line }}
    >
      <Text style={styles.optionLabel} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.optionRight}>
        <Text style={styles.optionDetail}>{detail}</Text>
        {selected ? (
          <MaterialIcons name="check" size={18} color={colors.accent} />
        ) : (
          <View style={styles.optionCheckSpacer} />
        )}
      </View>
    </Pressable>
  );
}

function EntryRow({
  entry,
  accountName,
  onPress,
}: {
  entry: ServerFinanceEntry;
  /** Undefined when the list is already scoped to one account, or when the
   * entry belongs to none — a manual entry made before any account existed
   * has nothing honest to label it with. */
  accountName?: string;
  onPress: () => void;
}) {
  const isExpense = entry.entry_type === "expense";
  const needsCategory = isUncategorized(entry.category);
  return (
    <Pressable onPress={onPress} style={styles.row} android_ripple={{ color: colors.line }}>
      <View style={styles.rowLeft}>
        <View style={styles.merchantLine}>
          <Text style={styles.merchant} numberOfLines={1}>
            {entry.merchant}
          </Text>
          {accountName ? (
            <Text style={styles.accountTag} numberOfLines={1}>
              {accountName}
            </Text>
          ) : null}
        </View>
        {/* An uncategorised entry is a prompt, not a category. Styling it as
            a tappable hint rather than a label stops it reading as a bug. */}
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
  total: { paddingHorizontal: 22, paddingTop: 16, paddingBottom: 12 },
  totalLabel: { color: colors.inkDim, fontSize: 11 },
  totalValue: {
    color: colors.ink,
    fontSize: 26,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  picker: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginHorizontal: 18,
    marginBottom: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
  },
  pickerLeft: { flex: 1, marginRight: 10 },
  pickerLabel: {
    color: colors.inkDim,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  pickerValue: { color: colors.ink, fontSize: 14, fontWeight: "600", marginTop: 2 },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.panel,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: 16,
    paddingBottom: 32,
    paddingHorizontal: 14,
    gap: 4,
  },
  sheetTitle: {
    color: colors.inkDim,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    paddingHorizontal: 6,
    paddingBottom: 8,
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  optionSelected: { backgroundColor: colors.canvas },
  optionLabel: { color: colors.ink, fontSize: 15, fontWeight: "600", flex: 1 },
  optionRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  optionDetail: {
    color: colors.inkDim,
    fontSize: 13,
    fontVariant: ["tabular-nums"],
  },
  // Keeps the amounts in a column whether or not a row has the tick.
  optionCheckSpacer: { width: 18 },
  merchantLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  accountTag: {
    color: colors.inkDim,
    fontSize: 10,
    fontWeight: "600",
    maxWidth: 110,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
    backgroundColor: colors.panel,
    overflow: "hidden",
  },
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
  merchant: { color: colors.ink, fontSize: 15, fontWeight: "500", flexShrink: 1 },
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
