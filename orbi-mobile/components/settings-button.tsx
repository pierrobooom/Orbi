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
import React, { useEffect } from "react";
import { Pressable, StyleSheet } from "react-native";

import { Avatar } from "@/components/avatar";
import { useProfileStore } from "@/stores/profileStore";
import { colors } from "@/theme/colors";

/** Opens Settings. Shows the user's face once there is one to show.
 *
 * A gear says "options"; a face says "you", and everything behind this
 * button is about the person rather than about the app — their plan, their
 * language, their quiet hours, their picture. It is also the pattern people
 * already have muscle memory for from every mail and browser app.
 *
 * The gear remains the fallback rather than a blank circle: before the
 * profile loads, and for anyone who has not set a picture, a familiar icon
 * is better than an empty ring that looks like a loading failure.
 */
export function SettingsButton({ tint = colors.inkDim }: { tint?: string }) {
  const router = useRouter();
  const avatarUrl = useProfileStore((s) => s.avatarUrl);
  const name = useProfileStore((s) => s.name);
  const load = useProfileStore((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Pressable
      onPress={() => router.push("/settings")}
      style={styles.button}
      accessibilityLabel="Settings"
      accessibilityRole="button"
    >
      {avatarUrl ? (
        <Avatar url={avatarUrl} name={name} size={28} />
      ) : (
        <MaterialIcons name="settings" size={24} color={tint} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // A real 48pt square rather than a 20px glyph with hitSlop bolted on.
  // hitSlop works, but it is invisible in every screenshot and every code
  // review, so it silently rots — and it cannot extend past a parent that
  // clips, which is exactly where headers put their controls.
  button: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    marginRight: -12,
  },
});
