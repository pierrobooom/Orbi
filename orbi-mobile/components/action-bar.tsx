// The primary action, where the thumb already is.
//
// WHY ACTIONS MOVE TO THE BOTTOM
// A thumb on a modern phone sweeps an arc across roughly the bottom 60% of
// the screen. Everything above that needs a grip-shuffle — the little
// two-stage regrip where you slide the phone down your palm, reach, and
// hope. Orbi asked for that shuffle on every save, because Save was a small
// text link in the top-right corner.
//
// The bottom of the screen is the one place both hands agree on. Putting the
// primary action there is worth more than any amount of mirroring.
//
// WHY THE DESTRUCTIVE ONE IS NOT HERE
// Delete is deliberately left in the header or behind a long-press. Easy to
// reach and easy to hit by accident are the same property, and the whole
// point of a thumb-friendly layout is that things under the thumb get
// pressed. A destructive action should cost a deliberate movement.
//
// The bar mirrors: with two buttons the primary sits on the holding-hand
// side, so the most likely press is the shortest reach.

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

interface Action {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
}

interface Props {
  primary: Action;
  /** Cancel, or a second choice. Rendered quieter and, when mirrored, on the
   * far side — the thumb should land on the one people mean. */
  secondary?: Action;
  style?: ViewStyle;
}

// Comfortably above the 44pt minimum: this is the control the screen exists
// to offer, and it should be impossible to miss.
const HEIGHT = 52;

export function ActionBar({ primary, secondary, style }: Props) {
  const mirrored = useMirrored();

  return (
    <View style={[styles.bar, mirrored && styles.mirrored, style]}>
      {secondary ? (
        <Pressable
          onPress={secondary.onPress}
          disabled={secondary.disabled || secondary.busy}
          style={[
            styles.button,
            styles.secondary,
            (secondary.disabled || secondary.busy) && styles.disabled,
          ]}
          accessibilityRole="button"
        >
          {secondary.busy ? (
            <ActivityIndicator color={colors.ink} size="small" />
          ) : (
            <Text style={styles.secondaryText} numberOfLines={1} adjustsFontSizeToFit>
              {secondary.label}
            </Text>
          )}
        </Pressable>
      ) : null}

      <Pressable
        onPress={primary.onPress}
        disabled={primary.disabled || primary.busy}
        style={[
          styles.button,
          styles.primary,
          // With no secondary the primary takes the whole width; with one it
          // takes the larger share, because it is the likelier press.
          secondary ? styles.primaryWithSecondary : styles.primaryAlone,
          (primary.disabled || primary.busy) && styles.disabled,
        ]}
        accessibilityRole="button"
      >
        {primary.busy ? (
          <ActivityIndicator color={colors.canvas} size="small" />
        ) : (
          <Text style={styles.primaryText} numberOfLines={1} adjustsFontSizeToFit>
            {primary.label}
          </Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    borderTopColor: colors.line,
    borderTopWidth: 1,
    backgroundColor: colors.canvas,
  },
  mirrored: { flexDirection: "row-reverse" },
  button: {
    height: HEIGHT,
    paddingHorizontal: 12,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  primary: { backgroundColor: colors.accent },
  primaryAlone: { flex: 1 },
  primaryWithSecondary: { flex: 2 },
  // Centred and capped to one line.
  //
  // Without textAlign a wrapped label renders left-aligned inside a centred
  // container, which reads as a broken button rather than a long word — and
  // "Organizar o resto" wraps on any phone. Shrinking to fit keeps the bar
  // one consistent height instead of growing for whichever translation
  // happens to be longest.
  primaryText: {
    color: colors.canvas,
    fontSize: 16,
    fontWeight: "700",
    textAlign: "center",
  },
  secondary: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
  },
  secondaryText: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
  },
  disabled: { opacity: 0.5 },
});
