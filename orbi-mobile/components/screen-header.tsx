// One header for every modal screen.
//
// WHY THIS EXISTS
// Nine screens had hand-rolled headers with the same shape and slightly
// different dimensions, and each put its actions wherever that file happened
// to. The result was that Close sat top-left on one screen and top-right on
// another, tap targets varied between 16 and 24 points, and nothing could be
// changed everywhere without editing nine files.
//
// WHY IT MIRRORS
// Both top corners are outside a thumb's arc, but not equally: the far corner
// is the unreachable one, and which corner is far depends on the hand. With
// one component owning the layout, honouring that is a single flag read
// rather than nine bespoke edits.
//
// Mirroring swaps SIDES, not meanings. Back still goes back and still shows a
// chevron pointing the way you came from; it simply sits under the thumb
// instead of across the screen from it.
//
// WHAT THIS DELIBERATELY DOES NOT DO
// It does not hold the primary action. Save, Done, Add and Delete belong in
// ActionBar at the bottom, where they are reachable — a header is for
// leaving the screen and for saying where you are.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useRouter } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";

import { useMirrored } from "@/stores/handednessStore";
import { colors } from "@/theme/colors";

interface Props {
  title: string;
  /** Defaults to router.back(). Pass a handler for a screen that must
   * confirm before leaving. */
  onBack?: () => void;
  /** "chevron" for a pushed screen, "close" for something that appeared over
   * the top. Different gestures got the user here, and the icon is the only
   * clue about which one leaving will undo. */
  backIcon?: "chevron" | "close" | "none";
  /** A secondary control — a refresh, an overflow menu. Never the primary
   * action: that belongs at the bottom of the screen. */
  action?: React.ReactNode;
  style?: ViewStyle;
}

// 44pt is the smallest reliable touch target on a phone. Several of the
// hand-rolled headers used 16–18pt icons with inconsistent hitSlop, which is
// a coin-flip to hit one-handed and a certainty to hit with two — the exact
// bug that only shows up in real use.
const TARGET = 44;

export function ScreenHeader({
  title,
  onBack,
  backIcon = "chevron",
  action,
  style,
}: Props) {
  const router = useRouter();
  const mirrored = useMirrored();

  const back =
    backIcon === "none" ? (
      <View style={styles.side} />
    ) : (
      <Pressable
        onPress={onBack ?? (() => router.back())}
        style={styles.side}
        accessibilityRole="button"
        accessibilityLabel={backIcon === "close" ? "Close" : "Back"}
      >
        <MaterialIcons
          name={backIcon === "close" ? "close" : "chevron-left"}
          size={24}
          color={colors.inkDim}
        />
      </Pressable>
    );

  return (
    <View style={[styles.header, mirrored && styles.mirrored, style]}>
      {back}
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      <View style={styles.side}>{action}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  // row-reverse rather than swapping the children, so the two orders can
  // never drift apart as the component grows.
  mirrored: { flexDirection: "row-reverse" },
  side: {
    minWidth: TARGET,
    height: TARGET,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { flex: 1, color: colors.ink, fontSize: 15, fontWeight: "600", textAlign: "center" },
});
