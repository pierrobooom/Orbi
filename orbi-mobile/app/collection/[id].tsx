// Screen 3 of the Collections mockups: a collection — the month's money on
// top (any month, with the arrows, and who paid when), then one card per
// resource, each showing its units side by side.
//
// The card's bars are the point of the screen: which room has paid, which
// is late, which is part-way, read in one glance without opening anything.

import { useFocusEffect, useLocalSearchParams, useRouter, type Href } from "expo-router";
import React, { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Chip, Eyebrow, kit, ProgressBar, stateChip, TopBar } from "@/components/collection/kit";
import { MonthCard } from "@/components/collection/month-card";
import { firstName, shortUnitName, unitCount } from "@/components/collection/naming";
import { useT } from "@/i18n";
import {
  ApiError,
  getCollection,
  getCollectionMonth,
  type CollectionCard,
  type CollectionView,
  type MonthItem,
  type MonthView,
} from "@/services/api";
import { colors } from "@/theme/colors";
import { themed } from "@/theme/themed";

export default function CollectionScreen() {
  const t = useT();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [data, setData] = useState<CollectionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // The month on screen; null is "this month", which comes with the
  // collection itself. Other months are fetched when the arrows reach them.
  const [month, setMonth] = useState<string | null>(null);
  const [months, setMonths] = useState<Record<string, MonthView>>({});
  // Read by load() without being a dependency: a dependency would make the
  // focus effect refetch the whole collection on every arrow tap.
  const monthRef = useRef<string | null>(null);

  const fetchMonth = useCallback(async (m: string) => {
    try {
      const view = await getCollectionMonth(String(id), m);
      setMonths((all) => ({ ...all, [m]: view }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("Could not load this collection."));
    }
  }, [id, t]);

  const load = useCallback(async () => {
    try {
      setData(await getCollection(String(id)));
      setError(null);
      // A payment recorded elsewhere may belong to the month being browsed:
      // drop the fetched months and refetch the one on screen.
      setMonths({});
      if (monthRef.current) void fetchMonth(monthRef.current);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("Could not load this collection."));
    }
  }, [id, t, fetchMonth]);

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
  const shown = month ?? data.month;
  const isCurrent = shown === data.month;
  const view = isCurrent ? { totals: data.totals, items: data.items } : months[shown];
  // Newest first: older is further along the list.
  const all = data.months?.length ? data.months : [data.month];
  const at = all.indexOf(shown);
  const go = (m: string | undefined) => {
    if (!m) return;
    monthRef.current = m === data.month ? null : m;
    setMonth(monthRef.current);
    if (m !== data.month && !months[m]) void fetchMonth(m);
  };
  const openItem = (item: MonthItem) =>
    router.push((item.resource_id ? `/collection/resource/${item.resource_id}` : `/collection/routine/${item.routine_id}`) as Href);
  const hasMoney = all.length > 1 || data.items?.length > 0 || data.totals.income.count + data.totals.expense.count > 0;

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

        {hasMoney ? (
          <MonthCard
            month={shown}
            isCurrent={isCurrent}
            totals={view?.totals ?? null}
            items={view?.items ?? null}
            owed={data.owed ?? []}
            canOlder={at >= 0 && at < all.length - 1}
            canNewer={at > 0}
            onOlder={() => go(all[at + 1])}
            onNewer={() => go(all[at - 1])}
            onToday={() => go(data.month)}
            onOpen={openItem}
          />
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
                {/* Progress shows even when late: a red outline with 43% inside says
                    both things at once. Drawing a late period as empty hid how much
                    had been paid, so a part-paid, overdue rent looked untouched. */}
                <ProgressBar pct={pct} late={late} style={styles.unitBar} />
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
  card: { marginBottom: 10 },
  pressed: { opacity: 0.7 },
  units: { flexDirection: "row", gap: 6, marginTop: 12 },
  unitBar: { marginTop: 0 },
  unitLabel: { color: colors.inkDim, fontSize: 10.5, marginTop: 5 },
  unitLate: { color: colors.overdue, fontWeight: "700" },
  add: { marginTop: 4 },
  empty: { color: colors.inkDim, fontSize: 14, lineHeight: 20, marginTop: 18, marginBottom: 14 },
}));
