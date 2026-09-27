// The app's text field: React Native's TextInput with a bar on top of the
// iOS keyboard that says how to put it away.
//
// WHY
// On iOS there is no key that hides the keyboard for a multi-line field,
// and for the rest the way out depended on the screen — tap somewhere
// blank, drag a list, press a Return that sometimes adds a new line
// instead. People were left guessing which part of the screen to press.
// Every field now carries the same bar with the same button in the same
// place.
//
// HOW
// Each field gets its own InputAccessoryView, keyed by a per-field id. A
// single shared bar mounted once at the root is lost when a modal screen is
// on top (the accessory has to be in the same view hierarchy as the field),
// and most typing in this app happens in modals.
//
// Android shows nothing extra: its system back button already hides the
// keyboard, and InputAccessoryView is iOS-only.
//
// Use it exactly like TextInput. `keyboardBar={false}` opts a field out.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import React, { forwardRef, useId } from "react";
import {
  InputAccessoryView,
  Keyboard,
  Platform,
  Pressable,
  TextInput as RNTextInput,
  StyleSheet,
  View,
  type TextInputProps as RNTextInputProps,
} from "react-native";

import { translate } from "@/i18n";
import { colors } from "@/theme/colors";
import { themed } from "@/theme/themed";

export type TextInputProps = RNTextInputProps & { keyboardBar?: boolean };

// Same name as the value below, on purpose: `useRef<TextInput>(null)` keeps
// meaning "a text input instance" in every file that switched to this.
export type TextInput = RNTextInput;

export const TextInput = forwardRef<RNTextInput, TextInputProps>(function AppTextInput(
  { keyboardBar = true, ...props },
  ref,
) {
  const id = `orbi-kb-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const withBar = keyboardBar && Platform.OS === "ios";
  return (
    <>
      <RNTextInput ref={ref} inputAccessoryViewID={withBar ? id : undefined} {...props} />
      {withBar ? (
        // Transparent strip, one small button at the right edge — a
        // full-width white bar read as part of the keyboard and looked
        // heavy. The icon is the keyboard-with-a-down-arrow everyone knows.
        <InputAccessoryView nativeID={id} backgroundColor="transparent">
          <View style={styles.bar} pointerEvents="box-none">
            <Pressable
              onPress={() => Keyboard.dismiss()}
              style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={translate("Hide keyboard")}
            >
              <MaterialIcons name="keyboard-hide" size={20} color={colors.ink} />
            </Pressable>
          </View>
        </InputAccessoryView>
      ) : null}
    </>
  );
});

const styles = themed(() => StyleSheet.create({
  bar: {
    height: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingHorizontal: 12,
    backgroundColor: "transparent",
  },
  pill: {
    width: 44,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.line,
    shadowColor: "#14161C",
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  pressed: { opacity: 0.6 },
}));
