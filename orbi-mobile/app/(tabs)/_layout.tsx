// Three-tab navigator per the locked sketch: Tasks, Universe (default), Money.
// Universe lives at the index route so the app lands there on cold start.

import { Tabs } from "expo-router";
import React from "react";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { HapticTab } from "@/components/haptic-tab";
import { useT } from "@/i18n";
import { colors } from "@/theme/colors";

// How wide each tab's touch target is, and therefore how tightly the four sit
// together. Tabs default to sharing the full width equally, which on a modern
// phone puts the outer two near the corners — the two hardest places for a
// thumb to reach without a regrip.
//
// TO RESTORE THE ORIGINAL SPREAD: delete tabBarItemStyle and the
// justifyContent line below, or `git checkout tabbar-full-width -- app/(tabs)/_layout.tsx`.
// The tag exists for exactly that.
const TAB_WIDTH = 76;

export default function TabLayout() {
  const t = useT();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.inkDim,
        // flex:0 stops each item stretching to fill its share, so the row
        // collapses to its natural width and centres.
        tabBarItemStyle: { flex: 0, width: TAB_WIDTH },
        tabBarStyle: {
          backgroundColor: colors.bg,
          borderTopColor: colors.line,
          justifyContent: "center",
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
