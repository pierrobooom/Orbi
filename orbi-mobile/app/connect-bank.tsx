// The consent explainer — shown before sending someone to their bank.
//
// This is the trust moment of the whole finance feature. A user is about to
// be thrown out of the app onto a bank login page, and if they do not know
// why, the honest reaction is to assume something is wrong and back out.
//
// WHAT THIS SCREEN IS NOT
// It is not a signup for anything. Users have no account with the bank-data
// provider, no API key, no portal — Orbi holds one application credential
// server-side and that is the entire point of the arrangement. The only
// thing the user ever does is approve access at their own bank.
//
// WHAT IT MUST SAY, AND WHY EACH LINE EARNS ITS PLACE
// People have one accurate instinct here: "an app is asking about my bank
// account". Every line answers a question they are right to be asking.
//   - Orbi never sees the password        → because they are about to type
//                                            one, and need to know where
//   - read-only, cannot move money        → the single biggest fear
//   - what it will see                    → informed consent means specific
//   - expires, and can be revoked         → it is reversible
// Vagueness here reads as evasion, so every claim is concrete.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ActionBar } from "@/components/action-bar";
import { ScreenHeader } from "@/components/screen-header";
import { translate, useT } from "@/i18n";
import { ApiError, connectAccount } from "@/services/api";
import { colors } from "@/theme/colors";
import { themed } from "@/theme/themed";

interface Step {
  icon: keyof typeof MaterialIcons.glyphMap;
  title: string;
  body: string;
}

export default function ConnectBankScreen() {
  const t = useT();
  const router = useRouter();
  const params = useLocalSearchParams<{
    id?: string;
    name?: string;
    institution?: string;
    country?: string;
  }>();
  const accountId = (params.id ?? "").toString();
  const accountName = (params.name ?? "").toString();
  const institution = (params.institution ?? "").toString();
  const country = (params.country ?? "").toString();

  const [busy, setBusy] = useState(false);

  const steps: Step[] = [
    {
      icon: "open-in-new",
      title: t("You'll go to your bank"),
      body: t("We open your bank's own website so you can sign in there. Orbi never sees your password or your security code."),
    },
    {
      icon: "check-circle-outline",
      title: t("You approve what we can see"),
      body: t("Your bank asks whether to share this account with Orbi. You decide, and your bank keeps the record."),
    },
    {
      icon: "sync",
      title: t("Then it updates itself"),
      body: t("Once a day Orbi checks for new transactions and sorts them into categories. Nothing to press."),
    },
  ];

  const onContinue = async () => {
    if (!accountId) return;
    setBusy(true);
    try {
      const result = await connectAccount(
        accountId,
        institution ? { institution, country: country || "PT" } : undefined,
      );
      if (result.authorization_url) {
        await Linking.openURL(result.authorization_url);
        // Back out to the accounts list — the user finishes in the browser
        // and returns to a connection that is already pending.
        router.back();
      } else {
        // No URL means a provider that needs no bank trip. Only the sandbox
        // does that, and it says so on its own status line.
        Alert.alert(translate("Connected"), result.message);
        router.back();
      }
    } catch (e) {
      const message = e instanceof ApiError ? e.message : String(e);
      Alert.alert(translate("Could not connect"), message);
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <ScreenHeader title={t("Automatic updates")} backIcon="close" />

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.lede}>
          {accountName
            ? t("Connect {name} so your spending appears on its own.", { name: accountName })
            : t("Connect your account so your spending appears on its own.")}
        </Text>

        {/* The chosen bank, stated and changeable before anyone leaves the
            app. Being sent to the wrong bank's login is disorienting enough
            that people abandon the whole flow rather than come back. */}
        {institution ? (
          <Pressable onPress={() => router.back()} style={styles.chosen}>
            <MaterialIcons name="account-balance" size={18} color={colors.accent} />
            <View style={styles.chosenBody}>
              <Text style={styles.chosenLabel}>{t("Your bank")}</Text>
              <Text style={styles.chosenName} numberOfLines={1}>
                {institution}
              </Text>
            </View>
            <Text style={styles.chosenChange}>{t("Change bank")}</Text>
          </Pressable>
        ) : null}

        <View style={styles.steps}>
          {steps.map((step, index) => (
            <View key={step.title} style={styles.step}>
              <View style={styles.stepIcon}>
                <MaterialIcons name={step.icon} size={20} color={colors.accent} />
              </View>
              <View style={styles.stepText}>
                <Text style={styles.stepTitle}>
                  {index + 1}. {step.title}
                </Text>
                <Text style={styles.stepBody}>{step.body}</Text>
              </View>
            </View>
          ))}
        </View>

        {/* Specific, not reassuring-sounding. "Your data is safe" tells
            nobody anything; "cannot move money" is a fact they can hold. */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t("What Orbi can and can't do")}</Text>

          <View style={styles.claim}>
            <MaterialIcons name="visibility" size={16} color={colors.health} />
            <Text style={styles.claimText}>
              {t("Can see: your transactions and balance, so it can sort your spending.")}
            </Text>
          </View>
          <View style={styles.claim}>
            <MaterialIcons name="block" size={16} color={colors.overdue} />
            <Text style={styles.claimText}>
              {t("Cannot move money. Access is read-only — no payments, no transfers.")}
            </Text>
          </View>
          <View style={styles.claim}>
            <MaterialIcons name="password" size={16} color={colors.overdue} />
            <Text style={styles.claimText}>
              {t("Never sees your login. You type it on your bank's site, not here.")}
            </Text>
          </View>
          <View style={styles.claim}>
            <MaterialIcons name="schedule" size={16} color={colors.inkDim} />
            <Text style={styles.claimText}>
              {t("Expires after about 90 days. Your bank asks you to approve again — we'll remind you a week before.")}
            </Text>
          </View>
          <View style={styles.claim}>
            <MaterialIcons name="link-off" size={16} color={colors.inkDim} />
            <Text style={styles.claimText}>
              {t("Stop any time. Disconnect here or at your bank. Transactions already saved stay yours.")}
            </Text>
          </View>
        </View>

        <Text style={styles.footnote}>
          {t("Orbi reaches your bank through a licensed open-banking provider — the same rules every banking app follows. Your finance data is never shared with anyone.")}
        </Text>


        {/* The honest alternative, offered rather than buried. Someone who
            does not want a standing connection should not be left feeling
            that automatic sync is the only way to use the feature. */}
        <Text style={styles.altHint}>
          {t("Prefer not to connect? You can import a statement from your bank instead — it works the same way, just manually.")}
        </Text>
      </ScrollView>

      {/* Pinned rather than at the end of the explainer. It used to sit
          below five paragraphs of consent copy, which put the one button
          the screen exists for below the fold AND out of thumb reach on a
          small phone. */}
      <ActionBar
        primary={{
          label: institution
            ? t("Continue to {bank}", { bank: institution })
            : t("Continue to my bank"),
          onPress: onContinue,
          disabled: !accountId,
          busy,
        }}
        secondary={{ label: t("Not now"), onPress: () => router.back() }}
      />
    </SafeAreaView>
  );
}

const styles = themed(() => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  body: { padding: 20, paddingBottom: 48 },
  lede: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: "600",
    lineHeight: 24,
    marginBottom: 24,
  },
  chosen: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    marginBottom: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
  },
  chosenBody: { flex: 1 },
  chosenLabel: {
    color: colors.inkDim,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  chosenName: { color: colors.ink, fontSize: 14, fontWeight: "700", marginTop: 2 },
  chosenChange: { color: colors.accent, fontSize: 12, fontWeight: "700" },
  steps: { gap: 18, marginBottom: 26 },
  step: { flexDirection: "row", gap: 12 },
  stepIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  stepText: { flex: 1 },
  stepTitle: { color: colors.ink, fontSize: 14, fontWeight: "700", marginBottom: 3 },
  stepBody: { color: colors.inkDim, fontSize: 13, lineHeight: 19 },
  card: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  cardTitle: { color: colors.ink, fontSize: 13, fontWeight: "700", marginBottom: 2 },
  claim: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  claimText: { color: colors.inkDim, fontSize: 12.5, lineHeight: 18, flex: 1 },
  footnote: {
    color: colors.inkDim,
    fontSize: 11,
    lineHeight: 17,
    marginTop: 16,
    marginBottom: 24,
  },
  altHint: {
    color: colors.inkDim,
    fontSize: 11,
    lineHeight: 17,
    textAlign: "center",
    paddingHorizontal: 8,
  },
}));
