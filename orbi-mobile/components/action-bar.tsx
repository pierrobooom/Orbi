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
import Animated, {
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";

import { MICRO, PRESS_SCALE, timing } from "@/theme/motion";

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

/** A button that dips under the thumb.
 *
 * 120ms and six per cent. The dip is the only confirmation a press has
 * registered before whatever it triggers finishes, and on a slow network
 * that gap is the whole of the user's experience of the tap. Animated
 * rather than a pressed-state style, because an instant snap to 0.94 reads
 * as a glitch while a curve reads as the button yielding.
 *
 * timing() carries ReduceMotion.System, so with that flag on the press
 * jumps straight to its end state instead of animating.
 */
function DipPressable({
  action,
  style: pressStyle,
  grow,
  children,
}: {
  action: Action;
  style: ViewStyle[];
  /** Share of the row. The primary takes two to the secondary's one when
   * both are present, because it is the likelier press — the ratio lives
   * on this wrapper because the wrapper, not the button, is the flex child. */
  grow: number;
  children: React.ReactNode;
}) {
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  const disabled = action.disabled || action.busy;

  return (
    <Animated.View style={[animated, { flex: grow }]}>
      <Pressable
        onPress={action.onPress}
        onPressIn={() => {
          scale.value = timing(PRESS_SCALE, MICRO);
        }}
        onPressOut={() => {
          scale.value = timing(1, MICRO);
        }}
        disabled={disabled}
        style={[...pressStyle, disabled && styles.disabled]}
        accessibilityRole="button"
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

export function ActionBar({ primary, secondary, style }: Props) {
  const mirrored = useMirrored();

  return (
    <View style={[styles.bar, mirrored && styles.mirrored, style]}>
      {secondary ? (
        <DipPressable
          action={secondary}
          grow={1}
          style={[styles.button, styles.secondary]}
        >
          {secondary.busy ? (
            <ActivityIndicator color={colors.ink} size="small" />
          ) : (
            <Text style={styles.secondaryText} numberOfLines={1} adjustsFontSizeToFit>
              {secondary.label}
            </Text>
          )}
        </DipPressable>
      ) : null}

      <DipPressable
        action={primary}
        grow={secondary ? 2 : 1}
        style={[styles.button, styles.primary, styles.fill]}
      >
        {primary.busy ? (
          <ActivityIndicator color={colors.canvas} size="small" />
        ) : (
          <Text style={styles.primaryText} numberOfLines={1} adjustsFontSizeToFit>
            {primary.label}
          </Text>
        )}
      </DipPressable>
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
  // The animated wrapper is the flex child now, so the share of the row is
  // set there (see DipPressable's `grow`) and the button fills what it gets.
  fill: { width: "100%" },
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
    width: "100%",
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
