// Screens 4, 5 and 7 of the Collections mockups — one route, three shapes:
//
//   a resource with units   (Casa 1)   → the units as cards, then the
//                                        resource's own routines as rows
//   a unit                  (Quarto 3) → its main routine's ring and
//                                        payments, then its other routines
//   a resource without units (Millie)  → its routines as boxes in a grid
//
// Which one is decided by the data, not by a setting: a house gets rooms by
// having rooms added, and a cat never does.

import { useFocusEffect, useLocalSearchParams, useRouter, type Href } from "expo-router";
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

import {
  Chip,
  daysUntil,
  Eyebrow,
  kit,
  lateText,
  money,
  monthName,
  ProgressBar,
  repeatText,
  shortDate,
  stateChip,
  TopBar,
} from "@/components/collection/kit";
import { firstName, unitCount, unitKind } from "@/components/collection/naming";
import { RoutineHero } from "@/components/collection/routine-hero";
import { dismissDeliveredFor } from "@/hooks/useNotificationActions";
import { useT } from "@/i18n";
import {
  ApiError,
  getCollection,
  getResource,
  settlePeriod,
  type CollectionCard,
  type CollectionRoutine,
  type CollectionUnitSummary,
  type ResourceView,
} from "@/services/api";
import { cue } from "@/services/feedback";
import { useUniverseStore } from "@/stores/universeStore";
import { colors } from "@/theme/colors";
import { themed } from "@/theme/themed";

const MAX_ROUTINES = 5;

export default function ResourceScreen() {
  const t = useT();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [data, setData] = useState<ResourceView | null>(null);
  const [siblings, setSiblings] = useState<CollectionCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const view = await getResource(String(id));
      setData(view);
      setError(null);
      // "Outros gatos": only for a resource without units, where the other
      // members of the collection are the natural next thing to open.
      if (!view.resource.parent_id && view.units.length === 0) {
        getCollection(view.cluster.id)
          .then((c) => setSiblings(c.resources.filter((r) => r.id !== view.resource.id)))
          .catch(() => setSiblings([]));
      }
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

  const { resource, parent, cluster, routines, units } = data;
  const isUnit = Boolean(resource.parent_id);
  const edit = () => router.push(`/collection/resource-editor?id=${resource.id}` as Href);
  const addRoutine = () => router.push(`/collection/routine-editor?resource=${resource.id}` as Href);
  const openRoutine = (r: CollectionRoutine) => router.push(`/collection/routine/${r.id}` as Href);

  const refresh = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
      tintColor={colors.inkDim}
    />
  );

  // ---- A unit: screen 5 ---------------------------------------------------
  if (isUnit) {
    const primary = routines.find((r) => r.kind === "amount") ?? routines[0] ?? null;
    const others = routines.filter((r) => r.id !== primary?.id);
    const since = resource.since_on ? t("since {date}", { date: `${monthName(resource.since_on)} ${resource.since_on.slice(0, 4)}` }) : null;
    const sub = [resource.person_name, parent?.name, since].filter(Boolean).join(" · ");
    return (
      <SafeAreaView style={kit.screen} edges={["top"]}>
        <TopBar action={{ icon: "edit-2", label: t("Edit"), onPress: edit }} />
        <ScrollView contentContainerStyle={kit.body} refreshControl={refresh}>
          <Text style={kit.title}>{resource.name}</Text>
          {sub ? <Text style={kit.sub}>{sub}</Text> : null}

          {primary ? <RoutineHero routine={primary} onChanged={load} /> : (
            <Text style={styles.empty}>{t("Add what repeats here — the rent, a deposit, a reading.")}</Text>
          )}

          <Eyebrow>
            {t("Routines here · {n} of {max}", { n: routines.length, max: MAX_ROUTINES })}
          </Eyebrow>
          {routines.length > 0 ? (
            <View style={[kit.card, styles.rowsCard]}>
              {[primary, ...others].filter(Boolean).map((r, i) => (
                <RoutineRow key={r!.id} routine={r!} first={i === 0} onPress={() => openRoutine(r!)} />
              ))}
            </View>
          ) : null}
          {routines.length < MAX_ROUTINES ? (
            <Pressable style={[kit.dashed, styles.addSmall]} onPress={addRoutine} accessibilityRole="button">
              <Text style={kit.dashedText}>+ {t("Routine")}</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ---- A resource with units: screen 4 -----------------------------------
  if (units.length > 0) {
    const kind = unitKind(units);
    const noun = cluster.collection_noun || t("item");
    return (
      <SafeAreaView style={kit.screen} edges={["top"]}>
        <TopBar action={{ icon: "edit-2", label: t("Edit"), onPress: edit }} />
        <ScrollView contentContainerStyle={kit.body} refreshControl={refresh}>
          <Text style={kit.title}>{resource.name}</Text>
          <Text style={kit.sub}>{[resource.subtitle, cluster.name].filter(Boolean).join(" · ")}</Text>

          <Eyebrow>
            {kind
              ? t("{units} · each on its own day", { units: kind.many })
              : t("{units} · each on its own day", { units: unitCount(units) })}
          </Eyebrow>
          {units.map((u) => (
            <UnitCard
              key={u.id}
              unit={u}
              onPress={() => router.push(`/collection/resource/${u.id}` as Href)}
            />
          ))}
          <Pressable
            style={[kit.dashed, styles.addSmall]}
            onPress={() => router.push(`/collection/resource-editor?cluster=${cluster.id}&parent=${resource.id}` as Href)}
            accessibilityRole="button"
          >
            <Text style={kit.dashedText}>+ {t("Add {noun}", { noun: kind?.one ?? t("unit") })}</Text>
          </Pressable>

          <Eyebrow>{t("For the whole {noun}", { noun })}</Eyebrow>
          {routines.length > 0 ? (
            <View style={[kit.card, styles.rowsCard]}>
              {routines.map((r, i) => (
                <RoutineRow key={r.id} routine={r} first={i === 0} onPress={() => openRoutine(r)} />
              ))}
            </View>
          ) : null}
          {routines.length < MAX_ROUTINES ? (
            <Pressable style={[kit.dashed, styles.addSmall]} onPress={addRoutine} accessibilityRole="button">
              <Text style={kit.dashedText}>+ {t("Routine")}</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ---- A resource without units: screen 7 --------------------------------
  const free = MAX_ROUTINES - routines.length;
  return (
    <SafeAreaView style={kit.screen} edges={["top"]}>
      <TopBar action={{ icon: "edit-2", label: t("Edit"), onPress: edit }} />
      <ScrollView contentContainerStyle={kit.body} refreshControl={refresh}>
        <View style={[kit.row, styles.avatarRow]}>
          <View style={[styles.avatar, { backgroundColor: cluster.color }]}>
            <Text style={styles.avatarText}>{resource.name.trim()[0]?.toUpperCase()}</Text>
          </View>
          <View style={styles.avatarText2}>
            <Text style={[kit.title, styles.petTitle]}>{resource.name}</Text>
            <Text style={kit.sub}>
              {[cluster.name, t("{n} routines of {max}", { n: routines.length, max: MAX_ROUTINES })].join(" · ")}
            </Text>
          </View>
        </View>
        {resource.subtitle ? <Text style={[kit.sub, styles.petSub]}>{resource.subtitle}</Text> : null}

        <View style={styles.grid}>
          {routines.map((r) => (
            <RoutineBox key={r.id} routine={r} onPress={() => openRoutine(r)} onChanged={load} />
          ))}
        </View>
        {free > 0 ? (
          <Pressable style={[kit.dashed, styles.addSmall]} onPress={addRoutine} accessibilityRole="button">
            <Text style={kit.dashedText}>
              + {free === 1 ? t("Routine (1 free)") : t("Routine ({n} free)", { n: free })}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          style={styles.addUnitLink}
          onPress={() => router.push(`/collection/resource-editor?cluster=${cluster.id}&parent=${resource.id}` as Href)}
          accessibilityRole="button"
        >
          <Text style={styles.addUnitText}>{t("Split into units (rooms, flats…)")}</Text>
        </Pressable>

        {siblings.length > 0 ? (
          <>
            <Eyebrow>{t("Others in {name}", { name: cluster.name })}</Eyebrow>
            <View style={styles.siblings}>
              {siblings.map((s) => (
                <Pressable
                  key={s.id}
                  onPress={() => router.replace(`/collection/resource/${s.id}` as Href)}
                  style={styles.sibling}
                >
                  <Text style={styles.siblingText}>{s.name}</Text>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

/** A room on the house screen: who, how much, which day, and where it stands. */
function UnitCard({ unit, onPress }: { unit: CollectionUnitSummary; onPress: () => void }) {
  const t = useT();
  const p = unit.primary;
  const late = p?.state === "late";
  const chip = p ? stateChip(p) : null;
  const title = unit.person_name ? `${unit.name} · ${unit.person_name}` : unit.name;
  let sub = "";
  if (p) {
    const amount = p.amount ? money(p.amount, p.currency) : null;
    const when = p.frequency === "monthly" && p.on_miss !== "from_done"
      ? t("pays on day {n}", { n: Number(p.anchor_on.slice(8, 10)) })
      : repeatText(p);
    sub = [amount, when].filter(Boolean).join(" · ");
  }
  const pct = p?.state === "done" ? 100 : p?.current?.pct ?? 0;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [kit.card, styles.unit, late && kit.cardLate, pressed && styles.pressed]}>
      <View style={kit.row}>
        <View style={kit.flex}>
          <Text style={styles.unitName}>{title}</Text>
          {sub ? <Text style={kit.small}>{sub}</Text> : null}
        </View>
        {chip && chip.label ? (
          chip.tone === "soon" && chip.label.includes("/") ? (
            <Text style={styles.partText}>{chip.label}</Text>
          ) : (
            <Chip tone={chip.tone} label={chip.label} />
          )
        ) : null}
      </View>
      {/* Real progress, outlined red when late — see app/collection/[id].tsx. */}
      {p ? <ProgressBar pct={pct} late={late} style={styles.unitBar} /> : null}
    </Pressable>
  );
}

/** A routine as a compact row: "Condomínio  mensal · dia 5 · €45   ✓". */
function RoutineRow({ routine, first, onPress }: { routine: CollectionRoutine; first: boolean; onPress: () => void }) {
  const chip = stateChip(routine);
  const detail = [repeatText(routine), routine.amount ? money(routine.amount, routine.currency) : null]
    .filter(Boolean).join(" · ");
  return (
    <Pressable onPress={onPress} style={[styles.rrow, !first && styles.rrowDivider]}>
      <Text style={styles.rrowTitle}>{routine.title}</Text>
      <Text style={styles.rrowDetail} numberOfLines={1}>{detail}</Text>
      <View style={kit.flex} />
      {chip.label ? <Chip tone={chip.tone} label={chip.label} /> : null}
    </Pressable>
  );
}

/** A routine as a box in the grid (screen 7): name, rhythm, state, action. */
function RoutineBox({ routine, onPress, onChanged }: {
  routine: CollectionRoutine; onPress: () => void; onChanged: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const period = routine.current;
  const open = Boolean(period && !period.completed_at);
  const late = routine.state === "late";
  const detail = [repeatText(routine), routine.amount ? money(routine.amount, routine.currency) : null]
    .filter(Boolean).join(" · ");

  const done = async () => {
    if (!period || busy) return;
    setBusy(true);
    try {
      await settlePeriod(period.id);
      cue("complete");
      if (period.task_id) await dismissDeliveredFor(period.task_id);
      void useUniverseStore.getState().hydrate();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  let body: React.ReactNode;
  if (routine.kind === "amount" && open && period) {
    body = (
      <>
        <ProgressBar pct={period.pct} late={late} />
        <Text style={styles.boxSmall}>
          {t("{paid} of {total}", { paid: money(period.paid, routine.currency), total: money(period.amount, routine.currency) })}
        </Text>
      </>
    );
  } else if (late) {
    body = (
      <>
        <Text style={[styles.boxWhen, styles.boxLate]}>{t("late {days}", { days: lateText(routine.late_days) })}</Text>
        <Pressable style={[kit.primaryBtn, styles.boxBtn]} onPress={done} disabled={busy}>
          {busy ? <ActivityIndicator color={colors.canvas} /> : <Text style={styles.boxBtnText}>{t("Done")}</Text>}
        </Pressable>
      </>
    );
  } else {
    const next = open ? period!.period_on : routine.next_on;
    const doneLast = period?.completed_at ? period : null;
    body = (
      <>
        {next ? <Text style={styles.boxWhen}>{shortDate(next)}</Text> : null}
        {doneLast ? (
          <Chip tone="ok" label={`✓ ${t("done {date}", { date: shortDate(doneLast.completed_at!.slice(0, 10)) })}`} style={styles.boxChip} />
        ) : next ? (
          <Chip tone="soon" label={daysUntil(next) <= 0 ? t("today") : t("in {n} days", { n: daysUntil(next) })} style={styles.boxChip} />
        ) : null}
        {open && daysUntil(period!.period_on) <= 0 ? (
          <Pressable style={[kit.primaryBtn, styles.boxBtn]} onPress={done} disabled={busy}>
            <Text style={styles.boxBtnText}>{t("Done")}</Text>
          </Pressable>
        ) : null}
      </>
    );
  }

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [kit.card, styles.box, late && kit.cardLate, pressed && styles.pressed]}>
      <Text style={styles.boxTitle}>{routine.title}</Text>
      <Text style={styles.boxSmall} numberOfLines={2}>{detail}</Text>
      <View style={styles.boxBody}>{body}</View>
    </Pressable>
  );
}

const styles = themed(() => StyleSheet.create({
  pressed: { opacity: 0.7 },
  empty: { color: colors.inkDim, fontSize: 14, lineHeight: 20, marginTop: 16 },
  rowsCard: { paddingVertical: 4 },
  addSmall: { marginTop: 8, paddingVertical: 10 },
  unit: { marginBottom: 8, paddingVertical: 11 },
  unitName: { color: colors.ink, fontSize: 14.5, fontWeight: "800" },
  unitBar: { marginTop: 8 },
  partText: { color: colors.health, fontSize: 13, fontWeight: "700" },
  rrow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, gap: 8 },
  rrowDivider: { borderTopWidth: 1, borderTopColor: colors.line },
  rrowTitle: { color: colors.ink, fontSize: 14, fontWeight: "700" },
  rrowDetail: { color: colors.inkDim, fontSize: 12.5, flexShrink: 1 },
  avatarRow: { marginTop: 10 },
  avatar: { width: 54, height: 54, borderRadius: 27, alignItems: "center", justifyContent: "center" },
  avatarText: { color: "white", fontSize: 22, fontWeight: "800" },
  avatarText2: { marginLeft: 12, flex: 1 },
  petTitle: { marginTop: 0, fontSize: 23 },
  petSub: { marginTop: 8 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 16 },
  box: { width: "48.5%", paddingHorizontal: 12, paddingVertical: 11, minHeight: 132 },
  boxTitle: { color: colors.ink, fontSize: 14, fontWeight: "800" },
  boxSmall: { color: colors.inkDim, fontSize: 11.5, marginTop: 3 },
  boxBody: { marginTop: 8 },
  boxWhen: { color: colors.ink, fontSize: 12.5, fontWeight: "700" },
  boxLate: { color: colors.overdue },
  boxChip: { marginTop: 6 },
  boxBtn: { marginTop: 8, paddingVertical: 8, borderRadius: 10 },
  boxBtnText: { color: colors.canvas, fontSize: 13, fontWeight: "700" },
  addUnitLink: { alignSelf: "center", paddingVertical: 12, marginTop: 4 },
  addUnitText: { color: colors.inkDim, fontSize: 12.5, textDecorationLine: "underline" },
  siblings: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  sibling: { backgroundColor: colors.line, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  siblingText: { color: colors.inkDim, fontSize: 13, fontWeight: "700" },
}));
