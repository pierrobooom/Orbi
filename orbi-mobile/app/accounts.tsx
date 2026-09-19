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
  Linking,
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
  connectAccount,
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
  const [connecting, setConnecting] = useState<string | null>(null);
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

  const onConnect = async (accountId: string) => {
    setConnecting(accountId);
    try {
      const result = await connectAccount(accountId);
      await load();
      if (result.authorization_url) {
        // Every real provider lands here: the user has to go to their own
        // bank, authenticate, and approve. Nothing the app holds can stand
        // in for that trip.
        Alert.alert(
          translate("Approve with your bank"),
          result.message,
          [
            { text: translate("Cancel"), style: "cancel" },
            {
              text: translate("Continue"),
              onPress: () => Linking.openURL(result.authorization_url as string),
            },
          ],
        );
      } else {
        Alert.alert(translate("Connected"), result.message);
      }
    } catch (e) {
      const message = e instanceof ApiError ? e.message : String(e);
      Alert.alert(translate("Could not connect"), message);
    } finally {
      setConnecting(null);
    }
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
      const lines = [
        t("{n} recurring entries created", { n: result.recurring_entries }),
        t("{n} transactions imported", { n: result.sync.imported }),
      ];
      // When no provider is configured, an import of zero is the expected
      // outcome rather than a failure — say which it is.
      if (provider && !provider.automatic_import) {
        lines.push(t("No bank provider is configured, so nothing was imported."));
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
                  if (link) {
                    return (
                      <Pressable
                        onPress={() => onDisconnect(link)}
                        style={styles.connectRow}
                      >
                        <MaterialIcons
                          name={link.status === "active" ? "link" : "schedule"}
                          size={15}
                          color={link.status === "active" ? colors.health : colors.inkDim}
                        />
                        <Text style={styles.connectText}>
                          {link.status === "active"
                            ? t("Connected · syncs daily")
                            : t("Waiting for your bank's approval")}
                        </Text>
                        <Text style={styles.disconnectText}>{t("Disconnect")}</Text>
                      </Pressable>
                    );
                  }
                  if (!provider?.automatic_import) return null;
                  return (
                    <Pressable
                      onPress={() => onConnect(row.account.id)}
                      disabled={connecting !== null}
                      style={[styles.connectBtn, connecting && styles.btnBusy]}
                    >
                      {connecting === row.account.id ? (
                        <ActivityIndicator color={colors.accent} size="small" />
                      ) : (
                        <Text style={styles.connectBtnText}>
                          {t("Connect for automatic import")}
                        </Text>
                      )}
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
