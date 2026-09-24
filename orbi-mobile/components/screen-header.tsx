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

import Feather from "@expo/vector-icons/Feather";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useRouter } from "expo-router";
import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";

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
  /** A secondary control — a refresh, a delete, an overflow menu. Never the
   * primary action: that belongs at the bottom of the screen.
   *
   * Described rather than passed as a node, so the TOUCH TARGET belongs to
   * this component. When callers supplied their own element they supplied a
   * bare 20px icon with a stingy hitSlop, and the 48pt slot around it was
   * decoration — the thing you actually had to hit was the glyph.
   */
  action?: {
    icon: keyof typeof MaterialIcons.glyphMap;
    onPress: () => void;
    label: string;
    tint?: string;
    busy?: boolean;
    disabled?: boolean;
  };
  style?: ViewStyle;
}

// 44pt is Apple's published minimum and it is a floor, not a target. Tested
// on a real phone it is still fiddly for larger hands at the top of the
// screen, where the thumb arrives at an angle rather than straight down. 48
// costs nothing — the space beside a title is empty anyway.
const TARGET = 48;
const ICON = 26;

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
        {/* A visible 38pt circle inside the 48pt target. The outline is
            what makes a lone chevron read as a button rather than as a
            stray glyph in the corner; the target stays 48 because that is
            what a thumb actually needs, and the two are different jobs. */}
        <View style={styles.backCircle}>
          <Feather
            name={backIcon === "close" ? "x" : "chevron-left"}
            size={19}
            color={colors.ink}
          />
        </View>
      </Pressable>
    );

  return (
    <View style={[styles.header, mirrored && styles.mirrored, style]}>
      {back}
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      {action ? (
        <Pressable
          onPress={action.onPress}
          disabled={action.disabled || action.busy}
          style={[styles.side, (action.disabled || action.busy) && styles.dim]}
          accessibilityRole="button"
          accessibilityLabel={action.label}
        >
          {action.busy ? (
            <ActivityIndicator size="small" color={action.tint ?? colors.inkDim} />
          ) : (
            <MaterialIcons
              name={action.icon}
              size={ICON}
              color={action.tint ?? colors.inkDim}
            />
          )}
        </Pressable>
      ) : (
        <View style={styles.side} />
      )}
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
  dim: { opacity: 0.5 },
  backCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
    alignItems: "center",
    justifyContent: "center",
  },
});
