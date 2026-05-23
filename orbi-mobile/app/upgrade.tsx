// Upgrade modal — three-plan comparison opened from the tier pill or from
// quota-exhausted error toasts.
//
// CTA is stubbed for now (Phase 5 ships RevenueCat IAP per the project
// roadmap). Tapping "Upgrade" surfaces an honest alert so we never imply
// payment works yet.

import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { registerPushDevice } from "@/hooks/usePushRegistration";
import { ApiError, sendTestPush } from "@/services/api";
import { useAuthStore, type SubscriptionTier } from "@/stores/authStore";
import { colors } from "@/theme/colors";

interface PlanCard {
  tier: SubscriptionTier;
  name: string;
  price: string;
  bullets: string[];
}

const PLANS: PlanCard[] = [
  {
    tier: "free",
    name: "Spark",
    price: "Free",
    bullets: [
      "50 bubbles · 3 clusters",
      "Voice in: on-device transcription",
      "30 AI turns per day",
      "Reactive personality",
      "30-day memory window",
    ],
  },
  {
    tier: "pro",
    name: "Pro",
    price: "£10.99 / month",
    bullets: [
      "500 bubbles · 15 clusters",
      "Voice in + ElevenLabs natural voice (on-demand)",
      "200 AI turns per day · Llama 70B",
      "Helpful personality",
      "1-year memory with semantic search",
      "Weekly + monthly finance reports",
    ],
  },
  {
    tier: "premium",
    name: "Genius",
    price: "£20.99 / month",
    bullets: [
      "Unlimited bubbles and clusters",
      "Claude on-demand for debriefs and weekly reviews",
      "500 AI turns per day · 100 Claude calls per month",
      "Talkative, opinionated personality",
      "Unlimited memory · cross-month synthesis",
      "Proactive daily reports",
    ],
  },
];

export default function UpgradeScreen() {
  const router = useRouter();
  const currentTier = useAuthStore((s) => s.tier);
  const [testPushBusy, setTestPushBusy] = useState(false);
  const [registerBusy, setRegisterBusy] = useState(false);

  const onUpgradeTap = (tier: SubscriptionTier) => {
    Alert.alert(
      "Coming soon",
      "Payments land in Phase 5 via the App Store and Play Store. Sit tight.",
      [{ text: "OK" }],
    );
  };

  const onTestPush = async () => {
    setTestPushBusy(true);
    try {
      const result = await sendTestPush();
      Alert.alert(
        "Test push sent",
        `Pushed to ${result.sent} device${result.sent === 1 ? "" : "s"}. Watch for the banner in a moment.`,
      );
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      Alert.alert("Test push failed", msg);
    } finally {
      setTestPushBusy(false);
    }
  };

  const onRegisterDevice = async () => {
    setRegisterBusy(true);
    const result = await registerPushDevice();
    setRegisterBusy(false);
    if (result.ok) {
      Alert.alert(
        "Device registered",
        `Push token sent to the backend. Last 12 chars: …${result.token.slice(-12)}`,
      );
    } else {
      Alert.alert("Registration failed", result.reason);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.headerCancel}>Close</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Your plan</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.intro}>
          Orbi has three tiers. Pick the one that fits your universe.
        </Text>

        {PLANS.map((plan) => {
          const isCurrent = plan.tier === currentTier;
          return (
            <View
              key={plan.tier}
              style={[styles.card, isCurrent && styles.cardCurrent]}
            >
              <View style={styles.cardHeader}>
                <Text style={styles.cardName}>{plan.name}</Text>
                <Text style={styles.cardPrice}>{plan.price}</Text>
              </View>
              {plan.bullets.map((b, i) => (
                <Text key={i} style={styles.bullet}>
                  · {b}
                </Text>
              ))}
              <Pressable
                onPress={() => (isCurrent ? null : onUpgradeTap(plan.tier))}
                disabled={isCurrent}
                style={[styles.cta, isCurrent && styles.ctaCurrent]}
              >
                <Text style={[styles.ctaText, isCurrent && styles.ctaTextCurrent]}>
                  {isCurrent ? "Current plan" : `Upgrade to ${plan.name}`}
                </Text>
              </Pressable>
            </View>
          );
        })}

        <Text style={styles.footnote}>
          Caps reset at midnight UTC each day. Monthly Claude calls reset on
          the 1st of each month.
        </Text>

        <View style={styles.devSection}>
          <Text style={styles.devLabel}>Dev tools</Text>

          <Pressable
            onPress={onRegisterDevice}
            disabled={registerBusy}
            style={[styles.devButton, registerBusy && styles.devButtonDisabled]}
          >
            {registerBusy ? (
              <ActivityIndicator color={colors.ink} />
            ) : (
              <Text style={styles.devButtonText}>Register push device</Text>
            )}
          </Pressable>
          <Text style={styles.devHint}>
            Re-runs the Expo push registration with permission prompt and
            sends the token to the backend. Use this to debug push issues.
          </Text>

          <Pressable
            onPress={onTestPush}
            disabled={testPushBusy}
            style={[styles.devButton, styles.devButtonStacked, testPushBusy && styles.devButtonDisabled]}
          >
            {testPushBusy ? (
              <ActivityIndicator color={colors.ink} />
            ) : (
              <Text style={styles.devButtonText}>Send test push</Text>
            )}
          </Pressable>
          <Text style={styles.devHint}>
            Fires a notification to every device registered for this user.
            Helps verify the push chain end-to-end. Removed before launch.
          </Text>
        </View>
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
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  headerTitle: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  headerCancel: { color: colors.inkDim, fontSize: 14, width: 60 },
  scroll: { padding: 20, paddingBottom: 60 },
  intro: { color: colors.inkDim, fontSize: 14, marginBottom: 18 },
  card: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 14,
    padding: 18,
    marginBottom: 14,
  },
  cardCurrent: { borderColor: colors.accent, borderWidth: 2 },
  cardHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  cardName: { color: colors.ink, fontSize: 20, fontWeight: "700" },
  cardPrice: { color: colors.inkDim, fontSize: 13, fontWeight: "600" },
  bullet: { color: colors.ink, fontSize: 13, lineHeight: 21 },
  cta: {
    marginTop: 14,
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  ctaCurrent: { backgroundColor: "transparent", borderColor: colors.line, borderWidth: 1 },
  ctaText: { color: "white", fontSize: 14, fontWeight: "700" },
  ctaTextCurrent: { color: colors.inkDim, fontWeight: "600" },
  footnote: { color: colors.inkDim, fontSize: 11, marginTop: 16, lineHeight: 16 },
  devSection: {
    marginTop: 28,
    paddingTop: 18,
    borderTopColor: colors.line,
    borderTopWidth: 1,
  },
  devLabel: {
    color: colors.inkDim,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 10,
  },
  devButton: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  devButtonDisabled: { opacity: 0.5 },
  devButtonStacked: { marginTop: 14 },
  devButtonText: { color: colors.ink, fontSize: 14, fontWeight: "600" },
  devHint: { color: colors.inkDim, fontSize: 11, marginTop: 8, lineHeight: 15 },
});
