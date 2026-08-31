// Three-tab navigator per the locked sketch: Tasks, Universe (default), Money.
// Universe lives at the index route so the app lands there on cold start.

import { Tabs } from "expo-router";
import React from "react";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { HapticTab } from "@/components/haptic-tab";
import { useT } from "@/i18n";
import { colors } from "@/theme/colors";

export default function TabLayout() {
  const t = useT();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.inkDim,
        tabBarStyle: {
          backgroundColor: colors.bg,
          borderTopColor: colors.line,
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
