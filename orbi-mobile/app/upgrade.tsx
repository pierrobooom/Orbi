// Upgrade modal — three-plan comparison opened from the tier pill or from
// quota-exhausted error toasts.
//
// CTA is stubbed for now (Phase 5 ships RevenueCat IAP per the project
// roadmap). Tapping "Upgrade" surfaces an honest alert so we never imply
// payment works yet.

import { useRouter } from "expo-router";
import React from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

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

  const onUpgradeTap = (tier: SubscriptionTier) => {
    Alert.alert(
      "Coming soon",
      "Payments land in Phase 5 via the App Store and Play Store. Sit tight.",
      [{ text: "OK" }],
    );
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
});
