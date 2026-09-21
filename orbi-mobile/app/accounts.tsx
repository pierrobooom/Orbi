// Accounts — where money lives, and what is actually in each one.
//
// Reached from the Money tab. Lists every account with its balance, offers
// add / edit / delete, and surfaces whether automatic bank import is even
// possible on this deployment.
//
// ON THE "SYNC NOW" BUTTON AND WHAT IT HONESTLY DOES
// The server reports which bank provider is configured. When that is the null
// provider — the default, because connecting to a bank needs a licensed
// aggregator nobody has signed up for yet — this screen says so in plain
// words instead of showing a Connect button that leads nowhere. Running the
// jobs still does something real: recurring rules materialise. It just will
// not invent transactions that no provider returned.
//
// Balances come from the server already derived (opening_balance + entries).
// They are deliberately not computed here: two implementations of the same
// arithmetic drift, and the one on the phone is the one that would be wrong.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { useFocusEffect, useRouter, type Href } from "expo-router";
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { translate, useT } from "@/i18n";
import {
  ApiError,
  deleteAccount,
  disconnectBank,
  getProviderStatus,
  importStatement,
  listAccounts,
  listBankConnections,
  runFinanceJobs,
  type AccountBalance,
  type BankConnection,
  type ProviderStatus,
} from "@/services/api";
import { useFinanceStore } from "@/stores/financeStore";
import { colors } from "@/theme/colors";

function formatMoney(amount: number, currency: string): string {
  const symbol =
    currency === "EUR" ? "€" : currency === "GBP" ? "£" : currency === "USD" ? "$" : "";
  return `${symbol}${amount.toFixed(2)}`;
}

/** Group an IBAN for reading: PT50 0002 0123 … Never for sending. */
function formatIban(iban: string): string {
  return iban.replace(/(.{4})/g, "$1 ").trim();
}

export default function AccountsScreen() {
  const t = useT();
  const router = useRouter();

  const [accounts, setAccounts] = useState<AccountBalance[] | null>(null);
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [connections, setConnections] = useState<BankConnection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [rows, status, links] = await Promise.all([
        listAccounts(),
        getProviderStatus(),
        listBankConnections(),
      ]);
      setAccounts(rows);
      setProvider(status);
      setConnections(links);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setAccounts((current) => current ?? []);
    }
  }, []);

  /** The live link for an account, if it has one.
   *
   * An account with no connection is a label, not a feed — which is exactly
   * why a sync over accounts alone imports nothing. */
  const connectionFor = (accountId: string) =>
    connections.find(
      (c) => c.account_id === accountId && ["pending", "active"].includes(c.status),
    );

  /** A connection that has stopped working and needs the user to act.
   *
   * Kept separate from connectionFor because these rows are not "connected"
   * — they fetch nothing — but they are not "never connected" either. Before
   * this, a lapsed consent simply vanished from the card and the account
   * offered a Connect button again, so the user never learned that their
   * feed had died or that the last few weeks of totals have a hole in them.
   */
  const brokenConnectionFor = (accountId: string) =>
    connections.find(
      (c) =>
        c.account_id === accountId &&
        ["expired", "revoked", "error"].includes(c.status),
    );

  /** Explain before redirecting, rather than after.
   *
   * Connecting throws the user out of the app onto a bank login page. An
   * alert fired mid-redirect is the wrong place to learn what is about to
   * happen — by then they are deciding under pressure, and the honest
   * reaction to a surprise bank prompt is to back out. The explainer screen
   * owns the decision and the API call.
   */
  const onConnect = (account: AccountBalance["account"]) => {
    // Bank first, explainer second. Which bank they use is something the user
    // already knows; what is about to happen is not — and the explainer reads
    // very differently once it can name the bank they are being sent to.
    router.push(
      `/bank-picker?id=${account.id}&name=${encodeURIComponent(account.name)}` as Href,
    );
  };

  /** Restart an approval that was never finished.
   *
   * The half-finished connection is dropped first rather than reused. Its
   * authorisation is single-use and short-lived, so resuming it would send
   * the user to a bank page that has already expired — and the unique index
   * refuses a second live connection on the same account anyway.
   */
  const onResume = async (
    account: AccountBalance["account"],
    link: BankConnection,
  ) => {
    try {
      await disconnectBank(link.id);
      await load();
    } catch {
      // Non-fatal: the connect screen will surface a real conflict.
    }
    onConnect(account);
  };

  /** Import a statement the user exported from their own bank.
   *
   * The only route to real transactions that needs no licence and no
   * aggregator. They already have the file; picking it is them handing it
   * over, which is a completely different act from granting an app standing
   * permission to read their account.
   */
  const onImport = async (accountId: string) => {
    let content: string;
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        // Deliberately broad: iOS reports CSVs as text/csv, text/comma-
        // separated-values, public.comma-separated-values-text or plain
        // octet-stream depending on where the file came from, and a narrow
        // filter greys out the very file the user just exported.
        type: ["text/csv", "text/comma-separated-values", "text/plain", "*/*"],
        copyToCacheDirectory: true,
      });
      if (picked.canceled || !picked.assets?.[0]) return;

      setImporting(accountId);
      content = await new File(picked.assets[0].uri).text();
    } catch (e) {
      setImporting(null);
      Alert.alert(translate("Could not read the file"), String(e));
      return;
    }

    try {
      const result = await importStatement(accountId, content);
      await load();
      const lines = [t("{n} transactions added", { n: result.imported })];
      // A small number is usually duplicates, not a failure — say so, or a
      // correct re-import looks broken.
      if (result.duplicates > 0) {
        lines.push(t("{n} were already there", { n: result.duplicates }));
      }
      if (result.skipped_pending > 0) {
        lines.push(t("{n} still pending, skipped", { n: result.skipped_pending }));
      }
      Alert.alert(translate("Statement imported"), lines.join("\n"));
    } catch (e) {
      Alert.alert(
        translate("Could not import"),
        e instanceof ApiError ? e.message : String(e),
      );
    } finally {
      setImporting(null);
    }
  };

  const onDisconnect = (connection: BankConnection) => {
    Alert.alert(
      translate("Disconnect?"),
      translate("Transactions already imported stay. This only stops new ones arriving."),
      [
        { text: translate("Cancel"), style: "cancel" },
        {
          text: translate("Disconnect"),
          style: "destructive",
          onPress: async () => {
            try {
              await disconnectBank(connection.id);
              await load();
            } catch (e) {
              Alert.alert(
                translate("Could not disconnect"),
                e instanceof ApiError ? e.message : String(e),
              );
            }
          },
        },
      ],
    );
  };

  // Reload on focus, not just on mount: the editor is a modal, so coming
  // back from it must show the change without a manual pull.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const onSync = async () => {
    setSyncing(true);
    try {
      const result = await runFinanceJobs();
      await load();
      // The Money tab keeps its own copy of the entries. Without this it
      // still shows the pre-sync list until the app is restarted, which is
      // exactly how "the expenses don't show up immediately" happens.
      await useFinanceStore.getState().hydrate();

      // "0 imported" reads as a failure. Distinguish the three reasons it can
      // legitimately be zero, so a working sync never looks broken.
      let lines: string[];
      if (result.throttled) {
        lines = [t("Already up to date — checked moments ago.")];
      } else if (provider && !provider.automatic_import) {
        lines = [t("No bank provider is configured, so nothing was imported.")];
      } else if (result.sync.imported === 0 && result.recurring_entries === 0) {
        lines = [t("No new transactions since the last check.")];
      } else {
        lines = [];
        if (result.sync.imported > 0) {
          lines.push(t("{n} transactions imported", { n: result.sync.imported }));
        }
        if (result.recurring_entries > 0) {
          lines.push(
            t("{n} recurring entries created", { n: result.recurring_entries }),
          );
        }
      }
      Alert.alert(translate("Finance updated"), lines.join("\n"));
    } catch (e) {
      Alert.alert(
        translate("Could not run"),
        e instanceof ApiError ? e.message : String(e),
      );
    } finally {
      setSyncing(false);
    }
  };

  const onDelete = (row: AccountBalance) => {
    Alert.alert(
      translate("Delete account?"),
      translate("Transactions stay in your history — they just stop being assigned to this account."),
      [
        { text: translate("Cancel"), style: "cancel" },
        {
          text: translate("Delete"),
          style: "destructive",
          onPress: async () => {
            try {
              await deleteAccount(row.account.id);
              await load();
            } catch (e) {
              Alert.alert(
                translate("Could not delete"),
                e instanceof ApiError ? e.message : String(e),
              );
            }
          },
        },
      ],
    );
  };

  const total = (accounts ?? [])
    .filter((r) => r.account.include_in_total)
    .reduce((sum, r) => sum + r.balance, 0);
  const currency = accounts?.[0]?.account.currency ?? "EUR";

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.headerSide}>
          <MaterialIcons name="chevron-left" size={24} color={colors.inkDim} />
        </Pressable>
        <Text style={styles.headerTitle}>{t("Accounts")}</Text>
        <Pressable
          onPress={() => router.push("/account-editor?id=new" as Href)}
          hitSlop={12}
          style={styles.headerSide}
          accessibilityLabel="Add account"
        >
          <MaterialIcons name="add" size={24} color={colors.accent} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.inkDim}
          />
        }
      >
        {accounts === null ? (
          <ActivityIndicator color={colors.accent} style={styles.loader} />
        ) : accounts.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{t("No accounts yet")}</Text>
            <Text style={styles.emptyBody}>
              {t("Add the accounts your money moves through. Each transaction can then be filed to one, so you can see what's actually in each.")}
            </Text>
            <Pressable
              onPress={() => router.push("/account-editor?id=new" as Href)}
              style={styles.emptyBtn}
            >
              <Text style={styles.emptyBtnText}>{t("Add an account")}</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View style={styles.totalCard}>
              <Text style={styles.totalLabel}>{t("Total")}</Text>
              <Text style={styles.totalValue}>{formatMoney(total, currency)}</Text>
              <Text style={styles.totalHint}>
                {t("Across accounts included in the total.")}
              </Text>
            </View>

            {accounts.map((row) => (
              <Pressable
                key={row.account.id}
                onPress={() =>
                  router.push(`/account-editor?id=${row.account.id}` as Href)
                }
                onLongPress={() => onDelete(row)}
                style={styles.card}
              >
                <View style={styles.cardTop}>
                  <View style={styles.cardNameGroup}>
                    <Text style={styles.cardName} numberOfLines={1}>
                      {row.account.name}
                    </Text>
                    {row.account.is_primary ? (
                      <MaterialIcons name="star" size={15} color={colors.finance} />
                    ) : null}
                  </View>
                  <Text
                    style={[
                      styles.cardBalance,
                      row.balance < 0 && styles.cardBalanceNegative,
                    ]}
                  >
                    {formatMoney(row.balance, row.account.currency)}
                  </Text>
                </View>
                <View style={styles.cardBottom}>
                  <Text style={styles.cardMeta} numberOfLines={1}>
                    {row.account.iban
                      ? formatIban(row.account.iban)
                      : t("No account number")}
                  </Text>
                  <Text style={styles.cardMeta}>
                    {t("{n} transactions", { n: row.entry_count })}
                  </Text>
                </View>
                {!row.account.include_in_total ? (
                  <Text style={styles.cardExcluded}>{t("Not counted in the total")}</Text>
                ) : null}

                {/* An account is only meaningful next to what moved through
                    it. Tapping the card edits the account; this goes to the
                    ledger filtered to it, which is the thing people actually
                    come here to see. */}
                <Pressable
                  onPress={() =>
                    router.push({
                      pathname: "/movements",
                      params: { account: row.account.id },
                    })
                  }
                  style={styles.importBtn}
                >
                  <MaterialIcons name="receipt-long" size={15} color={colors.ink} />
                  <Text style={styles.importBtnText}>
                    {t("Movements")}
                  </Text>
                </Pressable>

                {/* The import route: no licence, no aggregator, real data.
                    Offered on every account regardless of provider, because
                    it never depended on one. */}
                <Pressable
                  onPress={() => onImport(row.account.id)}
                  disabled={importing !== null}
                  style={[styles.importBtn, importing && styles.btnBusy]}
                >
                  {importing === row.account.id ? (
                    <ActivityIndicator color={colors.ink} size="small" />
                  ) : (
                    <>
                      <MaterialIcons
                        name="upload-file"
                        size={15}
                        color={colors.ink}
                      />
                      <Text style={styles.importBtnText}>
                        {t("Import a statement")}
                      </Text>
                    </>
                  )}
                </Pressable>

                {/* Connection state per account. Without a connection an
                    account is only a label, so this row is the difference
                    between a sync importing something and importing zero. */}
                {(() => {
                  const link = connectionFor(row.account.id);

                  // A pending connection used to be a dead end: it said
                  // "waiting for your bank" and offered no way to actually go
                  // and approve. Anyone who closed the bank page, or lost the
                  // link, was stuck with a connection that would never
                  // complete and a sync that silently did nothing.
                  if (link && link.status === "pending") {
                    return (
                      <View style={styles.connectRow}>
                        <MaterialIcons name="schedule" size={15} color={colors.inkDim} />
                        <Text style={styles.connectText}>
                          {t("Not approved yet")}
                        </Text>
                        <Pressable onPress={() => onResume(row.account, link)}>
                          <Text style={styles.resumeText}>{t("Finish")}</Text>
                        </Pressable>
                        <Pressable onPress={() => onDisconnect(link)}>
                          <Text style={styles.disconnectText}>{t("Cancel")}</Text>
                        </Pressable>
                      </View>
                    );
                  }

                  if (link) {
                    // Working, but consent is finite. Asking a week out is
                    // the difference between a renewal the user schedules
                    // and an outage they discover from a wrong total.
                    const endsInDays = link.consent_expires_at
                      ? Math.ceil(
                          (new Date(link.consent_expires_at).getTime() - Date.now()) /
                            86400000,
                        )
                      : null;
                    const endingSoon = endsInDays !== null && endsInDays <= 7;
                    return (
                      <>
                        <Pressable
                          onPress={() => onDisconnect(link)}
                          style={styles.connectRow}
                        >
                          <MaterialIcons name="link" size={15} color={colors.health} />
                          <Text style={styles.connectText}>
                            {link.last_synced_at
                              ? t("Connected · syncs daily")
                              : t("Connected · first sync pending")}
                          </Text>
                          <Text style={styles.disconnectText}>{t("Disconnect")}</Text>
                        </Pressable>
                        {endingSoon ? (
                          <Pressable
                            onPress={() => onConnect(row.account)}
                            style={styles.expiringRow}
                          >
                            <MaterialIcons
                              name="schedule"
                              size={14}
                              color={colors.finance}
                            />
                            <Text style={styles.expiringText}>
                              {endsInDays <= 0
                                ? t("Bank permission ends today")
                                : t("Bank permission ends in {n} days", {
                                    n: String(endsInDays),
                                  })}
                            </Text>
                            <Text style={styles.resumeText}>{t("Renew")}</Text>
                          </Pressable>
                        ) : null}
                      </>
                    );
                  }
                  // Stopped, and only the user can restart it: renewing a
                  // PSD2 consent means going back to the bank and approving
                  // again. Said plainly, with the date it stopped, because
                  // the totals since then are incomplete and the user is
                  // entitled to know which ones to distrust.
                  const broken = brokenConnectionFor(row.account.id);
                  if (broken) {
                    const stoppedOn = broken.last_synced_at
                      ? new Date(broken.last_synced_at).toLocaleDateString(undefined, {
                          day: "numeric",
                          month: "short",
                        })
                      : null;
                    const isError = broken.status === "error";
                    return (
                      <View style={styles.brokenBox}>
                        <View style={styles.brokenHead}>
                          <MaterialIcons
                            name="link-off"
                            size={15}
                            color={colors.overdue}
                          />
                          <Text style={styles.brokenText}>
                            {isError
                              ? t("Sync problem")
                              : stoppedOn
                                ? t("Stopped updating on {date}", { date: stoppedOn })
                                : t("Stopped updating")}
                          </Text>
                        </View>
                        <Text style={styles.brokenBody}>
                          {isError
                            ? t("We'll keep retrying. Reconnect if it persists.")
                            : t(
                                "Your bank's permission expired. New transactions aren't arriving until you reconnect.",
                              )}
                        </Text>
                        <View style={styles.brokenActions}>
                          <Pressable
                            onPress={() => onConnect(row.account)}
                            style={styles.reconnectBtn}
                          >
                            <Text style={styles.reconnectBtnText}>
                              {t("Reconnect")}
                            </Text>
                          </Pressable>
                          <Pressable onPress={() => onDisconnect(broken)}>
                            <Text style={styles.disconnectText}>{t("Remove")}</Text>
                          </Pressable>
                        </View>
                      </View>
                    );
                  }

                  if (!provider?.automatic_import) return null;
                  return (
                    <Pressable
                      onPress={() => onConnect(row.account)}
                      style={styles.connectBtn}
                    >
                      <Text style={styles.connectBtnText}>
                        {t("Connect for automatic import")}
                      </Text>
                    </Pressable>
                  );
                })()}
              </Pressable>
            ))}
          </>
        )}

        {/* Honest about what is and isn't connected. A Connect button that
            leads nowhere is worse than no button. */}
        {provider ? (
          <View style={styles.providerCard}>
            <View style={styles.providerRow}>
              <MaterialIcons
                name={provider.automatic_import ? "sync" : "edit-note"}
                size={18}
                color={colors.inkDim}
              />
              <Text style={styles.providerTitle}>
                {provider.automatic_import
                  ? t("Automatic import is on")
                  : t("Manual tracking")}
              </Text>
            </View>
            <Text style={styles.providerBody}>{provider.note}</Text>
            {!provider.automatic_import ? (
              <Text style={styles.providerBody}>
                {t("An account number labels an account and files imported transactions to it. It can't fetch anything on its own — banks only release transactions after you sign in with them directly and approve it.")}
              </Text>
            ) : null}
          </View>
        ) : null}

        <Pressable
          onPress={onSync}
          disabled={syncing}
          style={[styles.syncBtn, syncing && styles.btnBusy]}
        >
          {syncing ? (
            <ActivityIndicator color={colors.ink} />
          ) : (
            <Text style={styles.syncBtnText}>{t("Update now")}</Text>
          )}
        </Pressable>

        <Pressable
          onPress={() => router.push("/limits" as Href)}
          style={styles.linkRow}
        >
          <View style={styles.toggleLabelGroup}>
            <Text style={styles.rowLabel}>{t("Spending limits")}</Text>
            <Text style={styles.rowHint}>
              {t("A ceiling per category. Orbi tells you as you approach one — once, not every hour.")}
            </Text>
          </View>
          <MaterialIcons name="chevron-right" size={22} color={colors.inkDim} />
        </Pressable>

        <Pressable
          onPress={() => router.push("/recurring" as Href)}
          style={styles.linkRow}
        >
          <View style={styles.toggleLabelGroup}>
            <Text style={styles.rowLabel}>{t("Recurring transactions")}</Text>
            <Text style={styles.rowHint}>
              {t("Rent, subscriptions, the gym — entered once, created for you every time they're due.")}
            </Text>
          </View>
          <MaterialIcons name="chevron-right" size={22} color={colors.inkDim} />
        </Pressable>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Text style={styles.footHint}>{t("Long-press an account to delete it.")}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  headerSide: { minWidth: 40, alignItems: "center" },
  headerTitle: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  body: { padding: 16, paddingBottom: 48, gap: 12 },
  loader: { marginTop: 40 },
  empty: { alignItems: "center", paddingVertical: 48, gap: 10 },
  emptyTitle: { color: colors.ink, fontSize: 16, fontWeight: "700" },
  emptyBody: {
    color: colors.inkDim,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    paddingHorizontal: 12,
  },
  emptyBtn: {
    marginTop: 8,
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 10,
    backgroundColor: colors.accent,
  },
  emptyBtnText: { color: colors.canvas, fontSize: 14, fontWeight: "700" },
  totalCard: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
  },
  totalLabel: {
    color: colors.inkDim,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  totalValue: {
    color: colors.ink,
    fontSize: 30,
    fontWeight: "800",
    marginTop: 4,
    fontVariant: ["tabular-nums"],
  },
  totalHint: { color: colors.inkDim, fontSize: 11, marginTop: 4 },
  card: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 8,
  },
  cardTop: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  cardNameGroup: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 },
  cardName: { color: colors.ink, fontSize: 15, fontWeight: "600", flexShrink: 1 },
  cardBalance: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  cardBalanceNegative: { color: colors.overdue },
  cardBottom: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  cardMeta: { color: colors.inkDim, fontSize: 11, flexShrink: 1 },
  cardExcluded: { color: colors.inkDim, fontSize: 11, fontStyle: "italic" },
  connectBtn: {
    marginTop: 4,
    paddingVertical: 10,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.accent,
    alignItems: "center",
  },
  connectBtnText: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  importBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: 4,
    paddingVertical: 10,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.canvas,
  },
  importBtnText: { color: colors.ink, fontSize: 13, fontWeight: "600" },
  connectRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
    paddingTop: 8,
    borderTopColor: colors.line,
    borderTopWidth: 1,
  },
  connectText: { color: colors.inkDim, fontSize: 11, flex: 1 },
  disconnectText: { color: colors.overdue, fontSize: 11, fontWeight: "600" },
  resumeText: { color: colors.accent, fontSize: 11, fontWeight: "700" },
  expiringRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 6,
    paddingVertical: 7,
    paddingHorizontal: 9,
    borderRadius: 8,
    backgroundColor: colors.canvas,
  },
  expiringText: { color: colors.finance, fontSize: 11, flex: 1, fontWeight: "600" },
  brokenBox: {
    marginTop: 4,
    paddingTop: 8,
    borderTopColor: colors.line,
    borderTopWidth: 1,
  },
  brokenHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  brokenText: { color: colors.overdue, fontSize: 11, fontWeight: "700", flex: 1 },
  brokenBody: { color: colors.inkDim, fontSize: 11, lineHeight: 16, marginTop: 4 },
  brokenActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    marginTop: 10,
  },
  reconnectBtn: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: colors.accent,
  },
  reconnectBtnText: { color: colors.canvas, fontSize: 12, fontWeight: "700" },
  providerCard: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 8,
    marginTop: 4,
  },
  providerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  providerTitle: { color: colors.ink, fontSize: 13, fontWeight: "700" },
  providerBody: { color: colors.inkDim, fontSize: 12, lineHeight: 18 },
  syncBtn: {
    paddingVertical: 13,
    borderRadius: 10,
    borderColor: colors.line,
    borderWidth: 1,
    backgroundColor: colors.panel,
    alignItems: "center",
  },
  btnBusy: { opacity: 0.6 },
  syncBtnText: { color: colors.ink, fontSize: 14, fontWeight: "600" },
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
  },
  toggleLabelGroup: { flex: 1 },
  rowLabel: { color: colors.ink, fontSize: 14, fontWeight: "500" },
  rowHint: { color: colors.inkDim, fontSize: 11, marginTop: 6, lineHeight: 16 },
  error: { color: colors.overdue, fontSize: 12 },
  footHint: { color: colors.inkDim, fontSize: 11, textAlign: "center", marginTop: 4 },
});
