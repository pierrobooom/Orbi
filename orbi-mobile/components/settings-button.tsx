// The gear, in one place.
//
// Settings used to be reachable only by tapping the tier badge on the
// Universe screen — a target nobody would guess was a settings button, on
// one screen out of four. Anything a user might want mid-task (quiet hours,
// reminder volume, language) was three navigations away from wherever they
// actually were.
//
// A fifth tab was the other option and was rejected: the tab bar is for
// places you go repeatedly, and settings is somewhere you visit twice a
// month. A gear in the corner of every screen costs nothing and is where
// people already look for it.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useRouter } from "expo-router";
import React from "react";
import { Pressable, StyleSheet } from "react-native";

import { colors } from "@/theme/colors";

export function SettingsButton({ tint = colors.inkDim }: { tint?: string }) {
  const router = useRouter();
  return (
    <Pressable
      onPress={() => router.push("/settings")}
      hitSlop={12}
      style={styles.button}
      accessibilityLabel="Settings"
      accessibilityRole="button"
    >
      <MaterialIcons name="settings" size={20} color={tint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { padding: 2 },
});
