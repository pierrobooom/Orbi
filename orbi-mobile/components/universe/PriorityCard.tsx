// "Needs you first" — the one task worth interrupting the universe for.
//
// The universe is good at showing the shape of everything and bad at
// answering "what do I do now". This card answers only that: a single task,
// the most overdue one, or failing that the most pressing thing due today.
// One, not a list — a list is the Tasks tab, and the moment this shows three
// it has become a second, worse version of it.
//
// Red only when the task is actually late. A task merely due this afternoon
// keeps the same card in ink, because red is the app's word for "you have
// already missed this", and spending it on things that are fine dilutes it.

import Feather from "@expo/vector-icons/Feather";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useT } from "@/i18n";
import { describeDue } from "@/services/attention";
import type { ServerTask } from "@/services/api";
import { colors } from "@/theme/colors";
import { themed } from "@/theme/themed";

interface Props {
  task: ServerTask;
  clusterName: string | null;
  onPress: () => void;
  /** The current time, as a prop. The same task crosses from "due at
   * 18:00" to "late" without changing, so if the card read the clock itself
   * a memoised render would never notice. */
  now: Date;
  /** Tucks the card away to the screen edge. A visible button as well as
   * the swipe: an action you can only reach by guessing a gesture does not
   * exist for screen readers, or for anyone who never tries it. */
  onHide?: () => void;
}

export function PriorityCard({ task, clusterName, onPress, now, onHide }: Props) {
  const t = useT();
  const late = Boolean(task.due_at && new Date(task.due_at) < now);
  const tone = late ? colors.overdue : colors.ink;
  const due = describeDue(task, t, now);
  const meta = [clusterName, due].filter(Boolean).join(" · ");

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`${t("Needs you first")}: ${task.title}. ${meta}`}
    >
      <View style={styles.eyebrow}>
        <View style={[styles.dot, { backgroundColor: tone }]} />
        <Text style={[styles.eyebrowText, { color: tone }]}>
          {t("Needs you first")}
        </Text>
      </View>
      <Text style={styles.title} numberOfLines={2}>
        {task.title}
      </Text>
      {meta ? (
        <Text style={styles.meta} numberOfLines={1}>
          {meta}
        </Text>
      ) : null}
      {onHide ? (
        <Pressable
          onPress={onHide}
          hitSlop={10}
          style={styles.hide}
          accessibilityRole="button"
          accessibilityLabel={t("Hide")}
        >
          <Feather name="chevron-right" size={18} color={colors.inkDim} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

const styles = themed(() => StyleSheet.create({
  card: {
    backgroundColor: colors.panel,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    paddingVertical: 14,
    paddingHorizontal: 17,
    // Barely-there depth. The card sits over the universe, and a heavy
    // shadow would make it look like a modal that has to be dismissed.
    shadowColor: "#14161C",
    shadowOpacity: 0.05,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  pressed: { opacity: 0.85 },
  eyebrow: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  eyebrowText: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  hide: {
    position: "absolute",
    right: 8,
    top: 0,
    bottom: 0,
    width: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    paddingRight: 26,
    color: colors.ink,
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: -0.2,
    marginTop: 7,
  },
  meta: { color: colors.inkDim, fontSize: 12.5, marginTop: 3 },
}));
