// Placeholder — finance dashboard ships once /finance endpoints are wired up.

import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { colors } from "@/theme/colors";

export default function MoneyScreen() {
  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.center}>
        <Text style={styles.title}>Money</Text>
        <Text style={styles.hint}>Finance dashboard lands here in a later sprint.</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  title: { color: colors.ink, fontSize: 18, fontWeight: "700", marginBottom: 8 },
  hint: { color: colors.inkDim, fontSize: 13, textAlign: "center" },
});
