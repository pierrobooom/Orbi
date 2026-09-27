// One routine on its own: the same ring, payments and history as the room
// screen, for routines that are not a unit's main one (a cat's vaccine, the
// house's condominium fee).

import { useFocusEffect, useLocalSearchParams, useRouter, type Href } from "expo-router";
import React, { useCallback, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { kit, money, repeatText, TopBar } from "@/components/collection/kit";
import { RoutineHero } from "@/components/collection/routine-hero";
import { useT } from "@/i18n";
import { ApiError, getRoutine, type RoutineDetail } from "@/services/api";
import { colors } from "@/theme/colors";

export default function RoutineScreen() {
  const t = useT();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [data, setData] = useState<RoutineDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await getRoutine(String(id)));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("Could not load this."));
    }
  }, [id, t]);

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

  const { routine, resource } = data;
  const sub = [
    resource?.person_name ? `${resource.name} · ${resource.person_name}` : resource?.name,
    repeatText(routine),
    routine.amount ? money(routine.amount, routine.currency) : null,
  ].filter(Boolean).join(" · ");

  return (
    <SafeAreaView style={kit.screen} edges={["top"]}>
      <TopBar
        action={{
          icon: "edit-2",
          label: t("Edit"),
          onPress: () => router.push(`/collection/routine-editor?id=${routine.id}` as Href),
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
        <Text style={kit.title}>{routine.title}</Text>
        <Text style={kit.sub}>{sub}</Text>
        <RoutineHero routine={routine} onChanged={load} />
        {error ? <Text style={kit.error}>{error}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}
