// The gear, in one place — and the same gear on every screen.
//
// Settings used to be reachable only by tapping the tier badge on the
// Universe screen, a target nobody would guess was a settings button. A gear
// in the corner of every tab is where people already look for it.
//
// ONE COMPONENT, NOT A LOOK-ALIKE PER SCREEN
// The universe header drew its own outlined circle while the other tabs used
// this one, and the two drifted: different sizes, and for a while one showed
// a profile photo and the other a gear. Every screen now renders this
// component, so there is no second version to fall out of step.
//
// A gear, not the user's photo. A photo says "you"; this button opens
// settings, and a control should look like what it does.

import Feather from "@expo/vector-icons/Feather";
import { useRouter } from "expo-router";
import React from "react";
import { Pressable, StyleSheet } from "react-native";

import { useT } from "@/i18n";
import { colors } from "@/theme/colors";

/** Visible size. hitSlop lifts the touch target to 48, which is what a
 * thumb needs; the circle stays 40 so it sits quietly in a header. */
export const HEADER_BUTTON = 40;

export function SettingsButton({ tint = colors.ink }: { tint?: string }) {
  const router = useRouter();
  const t = useT();
  return (
    <Pressable
      onPress={() => router.push("/settings")}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      hitSlop={4}
      accessibilityLabel={t("Settings")}
      accessibilityRole="button"
    >
      <Feather name="settings" size={17} color={tint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: HEADER_BUTTON,
    height: HEADER_BUTTON,
    borderRadius: HEADER_BUTTON / 2,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { opacity: 0.6 },
});
