// Tab bar button with a soft haptic tick on press.
//
// PlatformPressable is imported from `expo-router/react-navigation`, NOT
// from `@react-navigation/elements`, and that distinction is the whole
// reason this file has a comment.
//
// Since SDK 57 expo-router vendors its own copy of @react-navigation, so
// both packages export types with identical names that TypeScript treats
// as unrelated ("two different types with this name exist"). Importing
// PlatformPressable from the standalone package makes this component's
// props structurally incompatible with the `tabBarButton` slot on
// expo-router's Tabs — the visible symptoms were pressColor typed as
// string vs ColorValue, and two distinct HoverEffectProps.
//
// Taking both the component and its props from expo-router's copy means
// there is exactly one type in play and no widening or casting is needed.

import * as Haptics from "expo-haptics";
import { PlatformPressable } from "expo-router/react-navigation";
import React from "react";

type TabButtonProps = React.ComponentProps<typeof PlatformPressable>;

export function HapticTab(props: TabButtonProps) {
  return (
    <PlatformPressable
      {...props}
      onPressIn={(ev) => {
        if (process.env.EXPO_OS === "ios") {
          // Soft haptic feedback when pressing down on a tab.
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }
        props.onPressIn?.(ev);
      }}
    />
  );
}
