// Centered empty-state for the Universe screen. Shown when the store is
// ready but bubbles.length === 0. A short hint points at the floating +
// button bottom-right.

import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { useT } from "@/i18n";
import { colors } from "@/theme/colors";

export default function EmptyState() {
  const t = useT();
  return (
    <View style={styles.root}>
      <Text style={styles.title}>{t("Your universe is empty")}</Text>
      <Text style={styles.body}>
        Tap the + button to add your first task.{"\n"}
        Bubbles grow with urgency and cluster by life domain.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 40,
  },
  title: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 10,
    textAlign: "center",
  },
  body: {
    color: colors.inkDim,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
  },
});
