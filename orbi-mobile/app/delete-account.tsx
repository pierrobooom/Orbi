// Permanent account deletion.
//
// Apple requires any app offering account creation to offer in-app
// account deletion, so this is a store-submission blocker rather than a
// nicety. It is also the single most destructive thing the app can do,
// which is why it is a full screen rather than an Alert: the user should
// read what goes, and typing their own email is a deliberate act in a
// way that tapping "Confirm" is not.
//
// Nothing is soft-deleted. The server removes the Supabase Auth user and
// the ON DELETE CASCADE chain takes every owned row with it.

import { useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { SafeAreaView } from "react-native-safe-area-context";

import { useT } from "@/i18n";
import { ApiError, deleteMyAccount } from "@/services/api";
import { useAuthStore } from "@/stores/authStore";
import { colors } from "@/theme/colors";

export default function DeleteAccountScreen() {
  const t = useT();
  const router = useRouter();
  const session = useAuthStore((s) => s.session);
  const signOut = useAuthStore((s) => s.signOut);

  const accountEmail = session?.user?.email ?? "";
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = useMemo(
    () =>
      typed.trim().length > 0 &&
      typed.trim().toLowerCase() === accountEmail.trim().toLowerCase(),
    [typed, accountEmail],
  );

  const onDelete = async () => {
    if (!matches || busy) return;
    Keyboard.dismiss();
    setError(null);
    setBusy(true);
    try {
      await deleteMyAccount(typed.trim());
      // The account is gone; signing out clears the local session and
      // AuthGate sends us to sign-in. Any error here is irrelevant —
      // there is no account left to stay signed into.
      try {
        await signOut();
      } catch {
        /* ignore */
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} disabled={busy}>
          <Text style={styles.headerCancel} numberOfLines={1}>
            {t("Cancel")}
          </Text>
        </Pressable>
        <Text style={styles.headerTitle}>{t("Delete account")}</Text>
        <View style={{ minWidth: 64 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.warnCard}>
          <MaterialIcons name="warning-amber" size={20} color={colors.overdue} />
          <Text style={styles.warnText}>
            {t("This cannot be undone. Everything below is deleted immediately.")}
          </Text>
        </View>

        <Text style={styles.label}>{t("What gets deleted")}</Text>
        {[
          t("Your account and sign-in"),
          t("Every task and cluster"),
          t("All finance entries and budgets"),
          t("Conversations and memories"),
          t("Preferences and notification devices"),
        ].map((line) => (
          <View key={line} style={styles.bulletRow}>
            <Text style={styles.bullet}>•</Text>
            <Text style={styles.bulletText}>{line}</Text>
          </View>
        ))}

        <Text style={styles.label}>{t("Type your email to confirm")}</Text>
        <Text style={styles.emailHint}>{accountEmail}</Text>
        <TextInput
          value={typed}
          onChangeText={setTyped}
          placeholder={accountEmail}
          placeholderTextColor={colors.inkDim}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          editable={!busy}
          returnKeyType="done"
          onSubmitEditing={() => Keyboard.dismiss()}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          onPress={onDelete}
          disabled={!matches || busy}
          style={[styles.destructive, (!matches || busy) && styles.disabled]}
        >
          {busy ? (
            <ActivityIndicator color="white" />
          ) : (
            <Text style={styles.destructiveText}>
              {t("Permanently delete my account")}
            </Text>
          )}
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  headerTitle: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  headerCancel: { color: colors.inkDim, fontSize: 14, minWidth: 64 },
  body: { padding: 24 },
  warnCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.overdue,
  },
  warnText: { color: colors.ink, fontSize: 13, flex: 1, lineHeight: 18 },
  label: {
    color: colors.inkDim,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginTop: 26,
    marginBottom: 8,
  },
  bulletRow: { flexDirection: "row", gap: 8, marginBottom: 4 },
  bullet: { color: colors.inkDim, fontSize: 14 },
  bulletText: { color: colors.ink, fontSize: 14, flex: 1, lineHeight: 20 },
  emailHint: { color: colors.ink, fontSize: 14, fontWeight: "600", marginBottom: 8 },
  input: {
    color: colors.ink,
    fontSize: 15,
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  error: { color: colors.overdue, fontSize: 13, marginTop: 16 },
  footer: { paddingHorizontal: 24, paddingVertical: 16 },
  destructive: {
    backgroundColor: colors.overdue,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  disabled: { opacity: 0.4 },
  destructiveText: { color: "white", fontSize: 15, fontWeight: "700" },
});
