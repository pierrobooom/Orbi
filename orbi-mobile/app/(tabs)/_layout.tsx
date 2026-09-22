// Three-tab navigator per the locked sketch: Tasks, Universe (default), Money.
// Universe lives at the index route so the app lands there on cold start.

import { Tabs } from "expo-router";
import React from "react";
import { useWindowDimensions } from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { HapticTab } from "@/components/haptic-tab";
import { useT } from "@/i18n";
import { colors } from "@/theme/colors";

// How wide each tab's touch target is, and therefore how tightly the four sit
// together. Tabs default to sharing the full width equally, which on a modern
// phone puts the outer two near the corners — the two hardest places for a
// thumb to reach without a regrip.
//
// TO RESTORE THE ORIGINAL SPREAD: `git checkout tabbar-full-width -- "app/(tabs)/_layout.tsx"`.
// The tag exists for exactly that. To keep centring but change how tight the
// group is, this is the only number to touch.
const TAB_WIDTH = 76;
const TAB_COUNT = 4;

export default function TabLayout() {
  const t = useT();
  const { width } = useWindowDimensions();

  // Centring is done with real padding rather than justifyContent.
  //
  // justifyContent on tabBarStyle was the obvious attempt and does nothing:
  // it applies to the bar's outer container, while the items live in a row
  // inside it that has already been told to fill the width. The row still
  // started at the left edge, so the tabs sat left-aligned with a gap on the
  // right — which is exactly what it looked like.
  //
  // Padding is applied to that same outer container and does push the row
  // inward, so the group ends up genuinely centred.
  const sidePadding = Math.max(0, (width - TAB_WIDTH * TAB_COUNT) / 2);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.inkDim,
        // flex:0 stops each item stretching to fill its share, so the row
        // collapses to its natural width — the padding above then centres it.
        tabBarItemStyle: { flex: 0, width: TAB_WIDTH },
        tabBarStyle: {
          backgroundColor: colors.bg,
          borderTopColor: colors.line,
          paddingHorizontal: sidePadding,
        },
      }}>
      <Tabs.Screen
        name="tasks"
        options={{
          title: t("Tasks"),
          tabBarIcon: ({ color, size }) => (
            <MaterialIcons name="checklist" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: t("Universe"),
          tabBarIcon: ({ color, size }) => (
            <MaterialIcons name="bubble-chart" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: t("Chat"),
          tabBarIcon: ({ color, size }) => (
            <MaterialIcons name="forum" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="money"
        options={{
          title: t("Money"),
          tabBarIcon: ({ color, size }) => (
            <MaterialIcons name="account-balance-wallet" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
