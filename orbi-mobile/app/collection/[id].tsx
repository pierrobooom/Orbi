// Screen 3 of the Collections mockups: a collection — this month's money on
// top, then one card per resource, each showing its units side by side.
//
// The card's bars are the point of the screen: which room has paid, which
// is late, which is part-way, read in one glance without opening anything.

import { useFocusEffect, useLocalSearchParams, useRouter, type Href } from "expo-router";
import React, { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Chip, Eyebrow, kit, money, monthName, MoneyText, ProgressBar, stateChip, TopBar } from "@/components/collection/kit";
import { firstName, shortUnitName, unitCount } from "@/components/collection/naming";
import { useT } from "@/i18n";
import { ApiError, getCollection, type CollectionCard, type CollectionView } from "@/services/api";
import { colors } from "@/theme/colors";
import { themed } from "@/theme/themed";

export default function CollectionScreen() {
  const t = useT();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [data, setData] = useState<CollectionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await getCollection(String(id)));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("Could not load this collection."));
    }
  }, [id, t]);

  // Reload whenever the screen comes back into view: a payment recorded on
  // the room screen must already be in the totals when you step back here.
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  if (!data) {
    return (
      <SafeAreaView style={kit.screen} edges={["top"]}>
        <TopBar />
        <View style={kit.centered}>
          {error ? <Text style={kit.error}>{error}</Text> : <ActivityIndicator color={colors.inkDim} />}
        </View>
      </SafeAreaView>
    );
  }

  const noun = data.cluster.collection_noun || t("item");
  const income = data.totals.income;
  const expense = data.totals.expense;
  const money_ = income.count > 0 ? income : expense.count > 0 ? expense : null;
  const receiving = income.count > 0;

  return (
    <SafeAreaView style={kit.screen} edges={["top"]}>
      <TopBar
        action={{
          icon: "more-horizontal",
          label: t("Collection settings"),
          onPress: () => router.push(`/cluster-editor?id=${data.cluster.id}` as Href),
        }}
      />
      <ScrollView
        contentContainerStyle={kit.body}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
            tintColor={colors.inkDim}
          />
        }
      >
        <Text style={kit.title}>{data.cluster.name}</Text>

        {money_ ? (
          <View style={[kit.card, styles.month]}>
            <Eyebrow style={styles.monthLabel}>{monthName(data.month, true)}</Eyebrow>
            <View style={styles.monthRow}>
              <MoneyText size={34}>{money(money_.paid)}</MoneyText>
              <Text style={styles.monthOf}>
                {receiving
                  ? t("of {total} received", { total: money(money_.target) })
                  : t("of {total} paid", { total: money(money_.target) })}
              </Text>
            </View>
            <ProgressBar pct={money_.pct} />
            <View style={[kit.row, styles.monthFoot]}>
              <Text style={styles.foot}>{t("{done} of {count} paid", { done: money_.done, count: money_.count })}</Text>
              <View style={kit.flex} />
              {data.late > 0 ? (
                <Text style={styles.lateFoot}>
                  {data.late === 1 ? t("1 late") : t("{n} late", { n: data.late })}
                </Text>
              ) : null}
            </View>
          </View>
        ) : null}

        {data.resources.length > 0 ? <Eyebrow>{data.cluster.name}</Eyebrow> : null}
        {data.resources.map((card) => (
          <ResourceCard
            key={card.id}
            card={card}
            onPress={() => router.push(`/collection/resource/${card.id}` as Href)}
          />
        ))}

        {data.resources.length === 0 ? (
          <Text style={styles.empty}>
            {t("Add the first {noun}. Each one keeps its own recurring things — rent, vaccines, inspections — and tells you when they are due.", { noun })}
          </Text>
        ) : null}

        <Pressable
          style={[kit.dashed, styles.add]}
          onPress={() => router.push(`/collection/resource-editor?cluster=${data.cluster.id}` as Href)}
          accessibilityRole="button"
        >
          <Text style={kit.dashedText}>+ {t("Add {noun}", { noun })}</Text>
        </Pressable>
        {error ? <Text style={kit.error}>{error}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function ResourceCard({ card, onPress }: { card: CollectionCard; onPress: () => void }) {
  const t = useT();
  const sub = [card.subtitle, card.units.length ? unitCount(card.units) : null].filter(Boolean).join(" · ");
  const chip = card.late > 0
    ? { tone: "late" as const, label: card.late === 1 ? t("1 late") : t("{n} late", { n: card.late }) }
    : card.primary ? stateChip(card.primary) : null;

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [kit.card, styles.card, pressed && styles.pressed]}>
      <View style={kit.row}>
        <View style={kit.flex}>
          <Text style={kit.name}>{card.name}</Text>
          {sub ? <Text style={kit.small}>{sub}</Text> : null}
        </View>
        {chip && chip.label ? <Chip tone={chip.tone} label={chip.label} /> : null}
      </View>

      {card.units.length > 0 ? (
        <View style={styles.units}>
          {card.units.map((u) => {
            const p = u.primary;
            const late = p?.state === "late";
            const pct = p?.state === "done" ? 100 : p?.current?.pct ?? 0;
            const who = firstName(u.person_name);
            return (
              <View key={u.id} style={kit.flex}>
                <ProgressBar pct={late ? 0 : pct} late={late} style={styles.unitBar} />
                <Text style={[styles.unitLabel, late && styles.unitLate]} numberOfLines={1}>
                  {shortUnitName(u.name)}{who ? ` · ${who}` : ""}
                </Text>
              </View>
            );
          })}
        </View>
      ) : card.primary ? (
        <ProgressBar
          pct={card.primary.state === "done" ? 100 : card.primary.current?.pct ?? 0}
          late={card.primary.state === "late"}
        />
      ) : null}
    </Pressable>
  );
}

const styles = themed(() => StyleSheet.create({
  month: { marginTop: 14 },
  monthLabel: { marginTop: 0, marginBottom: 4 },
  monthRow: { flexDirection: "row", alignItems: "baseline", flexWrap: "wrap" },
  monthOf: { color: colors.inkDim, fontSize: 13, marginLeft: 8 },
  monthFoot: { marginTop: 9 },
  foot: { color: colors.inkDim, fontSize: 12 },
  lateFoot: { color: colors.overdue, fontSize: 12, fontWeight: "700" },
  card: { marginBottom: 10 },
  pressed: { opacity: 0.7 },
  units: { flexDirection: "row", gap: 6, marginTop: 12 },
  unitBar: { marginTop: 0 },
  unitLabel: { color: colors.inkDim, fontSize: 10.5, marginTop: 5 },
  unitLate: { color: colors.overdue, fontWeight: "700" },
  add: { marginTop: 4 },
  empty: { color: colors.inkDim, fontSize: 14, lineHeight: 20, marginTop: 18, marginBottom: 14 },
}));
