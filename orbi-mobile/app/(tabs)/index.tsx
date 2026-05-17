// Universe tab — the bubble canvas + a top status strip showing the
// daily quota (mocked for now) and a /health connectivity badge.

import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import BubbleCanvas from "@/components/universe/BubbleCanvas";
import { getHealth, API_BASE_URL } from "@/services/api";
import { useAuthStore, type SubscriptionTier } from "@/stores/authStore";
import { colors } from "@/theme/colors";

type HealthBadge =
  | { status: "loading" }
  | { status: "ok"; app: string }
  | { status: "error"; message: string };

// Internal DB values stay 'free'|'pro'|'premium'; marketing names appear here.
const TIER_LABEL: Record<SubscriptionTier, string> = {
  free: "SPARK",
  pro: "PRO",
  premium: "GENIUS",
};

export default function UniverseScreen() {
  const tier = useAuthStore((s) => s.tier);
  const signOut = useAuthStore((s) => s.signOut);
  const [health, setHealth] = useState<HealthBadge>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    getHealth()
      .then((r) => !cancelled && setHealth({ status: "ok", app: r.app }))
      .catch((e) => !cancelled && setHealth({ status: "error", message: String(e.message ?? e) }));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.date}>Today</Text>
          <Pressable
            onLongPress={signOut}
            hitSlop={12}
            style={styles.tierPill}
            // Long-press to sign out. Temporary dev affordance; a proper
            // settings screen replaces this in a later sprint.
          >
            <Text style={styles.tierPillText}>{TIER_LABEL[tier]}</Text>
          </Pressable>
        </View>
        <HealthChip health={health} />
      </View>

      <BubbleCanvas />
    </SafeAreaView>
  );
}

function HealthChip({ health }: { health: HealthBadge }) {
  if (health.status === "loading") {
    return <Text style={styles.healthDim}>connecting…</Text>;
  }
  if (health.status === "ok") {
    return <Text style={styles.healthOk}>● backend ok</Text>;
  }
  return (
    <Text style={styles.healthErr} numberOfLines={1}>
      ● backend unreachable
    </Text>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  header: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
  date: { color: colors.ink, fontSize: 14, fontWeight: "600" },
  tierPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  tierPillText: { color: "white", fontSize: 9, fontWeight: "700", letterSpacing: 1 },
  healthOk: { color: colors.health, fontSize: 10 },
  healthDim: { color: colors.inkDim, fontSize: 10 },
  healthErr: { color: colors.overdue, fontSize: 10 },
});
