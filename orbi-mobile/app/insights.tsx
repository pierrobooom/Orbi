// Insights — what is worth noticing about this month.
//
// Two kinds of thing arrive in one list and are deliberately not labelled
// differently to the user: rules computed from the totals (free, exact, and
// what a Spark user gets) and observations written by the model. Which one
// produced a sentence is an implementation detail; whether it is true is
// not, and neither half is allowed to do arithmetic of its own.
//
// WHY THE REFRESH BUTTON IS QUIET ABOUT ITS LIMIT
// The server regenerates at most once a day per user. Tapping refresh more
// often is harmless and simply re-reads — so the button never fails, it just
// sometimes returns the same list. Saying "come back in 19 hours" would be
// louder than the feature deserves.
//
// An empty list is a real answer, not an error. A quiet month with nothing
// unusual in it should say so rather than pad the screen with filler, which
// is exactly how a user learns to ignore the whole feature.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/screen-header";
import { useT } from "@/i18n";
import {
  dismissInsight,
  getInsights,
  type InsightsResponse,
  type SpendingInsight,
} from "@/services/api";
import { formatCategory, isUncategorized } from "@/services/categories";
import { colors } from "@/theme/colors";
import { themed } from "@/theme/themed";

const SEVERITY_ICON: Record<
  SpendingInsight["severity"],
  keyof typeof MaterialIcons.glyphMap
> = {
  info: "lightbulb-outline",
  warning: "trending-up",
  alert: "error-outline",
};

function severityColor(severity: SpendingInsight["severity"]): string {
  if (severity === "alert") return colors.overdue;
  if (severity === "warning") return colors.accent;
  return colors.inkDim;
}

export default function InsightsScreen() {
  const t = useT();
  const router = useRouter();

  const [data, setData] = useState<InsightsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Hidden locally the moment it is dismissed, so the row disappears under
  // the finger rather than after a round trip.
  const [hidden, setHidden] = useState<string[]>([]);

  const load = useCallback(async (refresh = false) => {
    try {
      setData(await getInsights(refresh));
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load(true);
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const onDismiss = useCallback(async (id: string) => {
    setHidden((prev) => [...prev, id]);
    try {
      await dismissInsight(id);
    } catch {
      // Put it back rather than leaving the screen disagreeing with the
      // server about what exists.
      setHidden((prev) => prev.filter((x) => x !== id));
    }
  }, []);

  const insights = (data?.insights ?? []).filter(
    (i) => !i.id || !hidden.includes(i.id),
  );

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      {/* Refresh stays in the header: pull-to-refresh already covers the
          reachable path, so this is the redundant copy for people who don't
          think to pull. */}
      <ScreenHeader
        title={t("Insights")}
        action={{ icon: "refresh", onPress: onRefresh, label: "Refresh" }}
      />

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accent}
          />
        }
      >
        {loading ? (
          <ActivityIndicator color={colors.accent} style={styles.loader} />
        ) : insights.length === 0 ? (
          <View style={styles.empty}>
            <MaterialIcons name="auto-awesome" size={28} color={colors.inkDim} />
            <Text style={styles.emptyTitle}>{t("Nothing unusual this month")}</Text>
            <Text style={styles.emptyBody}>
              {(data?.entry_count ?? 0) < 4
                ? t(
                    "A few more transactions and there will be something to compare against.",
                  )
                : t(
                    "Your spending looks like it usually does. This fills up when something stands out.",
                  )}
            </Text>
          </View>
        ) : (
          insights.map((insight, index) => (
            <View key={insight.id ?? `rule-${index}`} style={styles.card}>
              <MaterialIcons
                name={SEVERITY_ICON[insight.severity]}
                size={18}
                color={severityColor(insight.severity)}
                style={styles.cardIcon}
              />
              <View style={styles.cardBody}>
                <Text style={styles.cardText}>{insight.insight_text}</Text>
                {insight.subject && !isUncategorized(insight.subject) ? (
                  <Text style={styles.cardSubject}>
                    {formatCategory(insight.subject)}
                  </Text>
                ) : null}
              </View>
              {/* Only stored insights can be dismissed — a rule is recomputed
                  on every read, so hiding one would last until the next
                  refresh and look broken. */}
              {insight.id ? (
                <Pressable
                  onPress={() => onDismiss(insight.id!)}
                  hitSlop={10}
                  style={styles.dismiss}
                  accessibilityLabel="Dismiss"
                >
                  <MaterialIcons name="close" size={16} color={colors.inkDim} />
                </Pressable>
              ) : null}
            </View>
          ))
        )}

        {/* Said once, at the bottom, so Spark users know what is missing
            rather than assuming the feature is broken. */}
        {!loading && data && !data.ai_available ? (
          <Pressable onPress={() => router.push("/upgrade")} style={styles.upsell}>
            <Text style={styles.upsellTitle}>{t("Written insights are on Pro")}</Text>
            <Text style={styles.upsellBody}>
              {t(
                "The observations above are computed from your totals. Pro adds written analysis of patterns across the month.",
              )}
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = themed(() => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  body: { padding: 16, paddingBottom: 48, gap: 10 },
  loader: { marginTop: 40 },
  card: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
  },
  cardIcon: { marginTop: 1, marginRight: 10 },
  cardBody: { flex: 1 },
  cardText: { color: colors.ink, fontSize: 14, lineHeight: 20 },
  cardSubject: {
    color: colors.inkDim,
    fontSize: 11,
    marginTop: 5,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: "700",
  },
  dismiss: { paddingLeft: 10, paddingTop: 1 },
  empty: { alignItems: "center", paddingTop: 60, paddingHorizontal: 24, gap: 8 },
  emptyTitle: { color: colors.ink, fontSize: 16, fontWeight: "600" },
  emptyBody: {
    color: colors.inkDim,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
  },
  upsell: {
    marginTop: 14,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
  },
  upsellTitle: { color: colors.accent, fontSize: 13, fontWeight: "700" },
  upsellBody: { color: colors.inkDim, fontSize: 12, lineHeight: 18, marginTop: 4 },
}));
