// Account editor — create or edit one account.
//
//   /account-editor?id=new   → create
//   /account-editor?id={id}  → edit
//
// THE ACCOUNT NUMBER FIELD
// Optional, and labelled as what it is. An IBAN identifies an account; it
// does not authorise reading one, so typing it here connects nothing. What it
// genuinely buys is filing: when a statement or a provider feed arrives, it
// names accounts by IBAN, and a user who has already told us theirs never
// sees a "which account is this?" dialog.
//
// The checksum is validated on the phone because it is free to do and catches
// the common failure — a digit dropped while copying from a banking app —
// at the moment the user can still see what they typed.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ActionBar } from "@/components/action-bar";
import { ScreenHeader } from "@/components/screen-header";
import { translate, useT } from "@/i18n";
import {
  ApiError,
  createAccount,
  listAccounts,
  updateAccount,
  type FinanceAccount,
} from "@/services/api";
import { colors } from "@/theme/colors";
import { themed } from "@/theme/themed";

const CURRENCIES = ["EUR", "GBP", "USD"] as const;

/** IBAN mod-97 check (ISO 13616).
 *
 * Move the first four characters to the end, turn letters into numbers
 * (A=10…Z=35), and the whole thing mod 97 must be 1. Done in chunks because
 * an IBAN as an integer overflows a JS number long before the end.
 *
 * Catches a mistyped or truncated number, which is the realistic error here.
 * It cannot tell you the account exists — nothing offline can.
 */
function isValidIban(raw: string): boolean {
  const iban = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;

  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const digits = rearranged
    .split("")
    .map((ch) => (/[A-Z]/.test(ch) ? (ch.charCodeAt(0) - 55).toString() : ch))
    .join("");

  let remainder = 0;
  for (let i = 0; i < digits.length; i += 7) {
    remainder = Number(String(remainder) + digits.slice(i, i + 7)) % 97;
  }
  return remainder === 1;
}

export default function AccountEditorScreen() {
  const t = useT();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const id = (params.id ?? "new").toString();
  const isNew = id === "new";

  const [name, setName] = useState("");
  const [iban, setIban] = useState("");
  const [currency, setCurrency] = useState<string>("EUR");
  const [openingBalance, setOpeningBalance] = useState("0");
  const [isPrimary, setIsPrimary] = useState(false);
  const [includeInTotal, setIncludeInTotal] = useState(true);
  const [visible, setVisible] = useState(true);

  const [loading, setLoading] = useState(!isNew);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isNew) return;
    // No single-account GET exists; the list is small and already the
    // shape this screen needs, so reuse it rather than adding an endpoint.
    listAccounts()
      .then((rows) => {
        const found = rows.find((r) => r.account.id === id);
        if (!found) {
          setError(translate("Account not found"));
          return;
        }
        const a: FinanceAccount = found.account;
        setName(a.name);
        setIban(a.iban ?? "");
        setCurrency(a.currency);
        setOpeningBalance(String(a.opening_balance));
        setIsPrimary(a.is_primary);
        setIncludeInTotal(a.include_in_total);
        setVisible(a.visible);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [id, isNew]);

  const trimmedIban = iban.replace(/\s+/g, "");
  const ibanLooksWrong = trimmedIban.length > 0 && !isValidIban(trimmedIban);
  const canSave = name.trim().length > 0 && !busy && !ibanLooksWrong;

  const onSave = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const parsedBalance = Number(openingBalance.replace(",", "."));
      const payload = {
        name: name.trim(),
        iban: trimmedIban || null,
        is_primary: isPrimary,
        include_in_total: includeInTotal,
        visible,
        opening_balance: Number.isFinite(parsedBalance) ? parsedBalance : 0,
      };
      if (isNew) {
        await createAccount({ ...payload, currency });
      } else {
        await updateAccount(id, payload);
      }
      router.back();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        <ScreenHeader
          title={isNew ? t("New account") : t("Edit account")}
          backIcon="close"
        />

        {loading ? (
          <ActivityIndicator color={colors.accent} style={styles.loader} />
        ) : (
          <ScrollView
            contentContainerStyle={styles.body}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.label}>{t("Name")}</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder={t("Revolut, Caixa, Savings…")}
              placeholderTextColor={colors.inkDim}
              maxLength={60}
              style={styles.input}
              autoFocus={isNew}
              autoCapitalize="words"
              returnKeyType="next"
            />

            <Text style={[styles.label, styles.labelSpaced]}>
              {t("Account number (optional)")}
            </Text>
            <TextInput
              value={iban}
              onChangeText={setIban}
              placeholder="PT50 0002 0123 1234 5678 9015 4"
              placeholderTextColor={colors.inkDim}
              maxLength={42}
              style={[styles.input, styles.mono, ibanLooksWrong && styles.inputError]}
              autoCapitalize="characters"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={() => Keyboard.dismiss()}
            />
            {ibanLooksWrong ? (
              <Text style={styles.fieldError}>
                {t("That doesn't look like a valid IBAN — check for a missing digit.")}
              </Text>
            ) : (
              <Text style={styles.hint}>
                {t("Used to label this account and to file imported transactions to it. It doesn't connect to your bank on its own — no app can read an account from its number alone.")}
              </Text>
            )}

            {isNew ? (
              <>
                <Text style={[styles.label, styles.labelSpaced]}>{t("Currency")}</Text>
                <View style={styles.currencyRow}>
                  {CURRENCIES.map((code) => {
                    const active = currency === code;
                    return (
                      <Pressable
                        key={code}
                        onPress={() => setCurrency(code)}
                        style={[styles.currencyPip, active && styles.currencyPipActive]}
                      >
                        <Text
                          style={[
                            styles.currencyText,
                            active && styles.currencyTextActive,
                          ]}
                        >
                          {code}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Text style={styles.hint}>
                  {t("Can't be changed later — it would reinterpret every amount already recorded.")}
                </Text>
              </>
            ) : null}

            <Text style={[styles.label, styles.labelSpaced]}>{t("Starting balance")}</Text>
            <TextInput
              value={openingBalance}
              onChangeText={setOpeningBalance}
              placeholder="0.00"
              placeholderTextColor={colors.inkDim}
              keyboardType="decimal-pad"
              style={[styles.input, styles.mono]}
              returnKeyType="done"
              onSubmitEditing={() => Keyboard.dismiss()}
            />
            <Text style={styles.hint}>
              {t("What was in the account when you started tracking. Every transaction you record moves the balance from here.")}
            </Text>

            <View style={styles.toggleRow}>
              <View style={styles.toggleLabelGroup}>
                <Text style={styles.rowLabel}>{t("Primary account")}</Text>
                <Text style={styles.rowHint}>
                  {t("The default for new transactions, including ones from a receipt photo.")}
                </Text>
              </View>
              <Switch
                value={isPrimary}
                onValueChange={setIsPrimary}
                trackColor={{ false: colors.line, true: colors.accent }}
              />
            </View>

            <View style={styles.toggleRow}>
              <View style={styles.toggleLabelGroup}>
                <Text style={styles.rowLabel}>{t("Include in total")}</Text>
                <Text style={styles.rowHint}>
                  {t("Turn off for an account you track but don't count as yours to spend.")}
                </Text>
              </View>
              <Switch
                value={includeInTotal}
                onValueChange={setIncludeInTotal}
                trackColor={{ false: colors.line, true: colors.accent }}
              />
            </View>

            <View style={styles.toggleRow}>
              <View style={styles.toggleLabelGroup}>
                <Text style={styles.rowLabel}>{t("Visible")}</Text>
                <Text style={styles.rowHint}>
                  {t("Hidden accounts stay in your data but drop out of the list.")}
                </Text>
              </View>
              <Switch
                value={visible}
                onValueChange={setVisible}
                trackColor={{ false: colors.line, true: colors.accent }}
              />
            </View>

            {error ? <Text style={styles.error}>{error}</Text> : null}
          </ScrollView>
        )}

        <ActionBar
          primary={{ label: t("Save"), onPress: onSave, disabled: !canSave, busy }}
          secondary={{ label: t("Cancel"), onPress: () => router.back() }}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = themed(() => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  flex: { flex: 1 },
  loader: { marginTop: 40 },
  body: { padding: 20, paddingBottom: 60 },
  label: { color: colors.ink, fontSize: 13, fontWeight: "600", marginBottom: 8 },
  labelSpaced: { marginTop: 22 },
  input: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.ink,
    fontSize: 15,
  },
  inputError: { borderColor: colors.overdue },
  mono: { fontVariant: ["tabular-nums"], letterSpacing: 0.5 },
  hint: { color: colors.inkDim, fontSize: 11, lineHeight: 16, marginTop: 8 },
  fieldError: { color: colors.overdue, fontSize: 11, marginTop: 8 },
  currencyRow: { flexDirection: "row", gap: 8 },
  currencyPip: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
    alignItems: "center",
  },
  currencyPipActive: { borderColor: colors.accent, backgroundColor: colors.accent },
  currencyText: { color: colors.inkDim, fontSize: 13, fontWeight: "600" },
  currencyTextActive: { color: colors.canvas },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginTop: 22,
  },
  toggleLabelGroup: { flex: 1 },
  rowLabel: { color: colors.ink, fontSize: 14, fontWeight: "500" },
  rowHint: { color: colors.inkDim, fontSize: 11, marginTop: 6, lineHeight: 16 },
  error: { color: colors.overdue, fontSize: 12, marginTop: 20 },
}));
