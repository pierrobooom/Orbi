// Public route group — sign-in and sign-up live here. Route gating in the
// root layout sends signed-out users into this stack and signed-in users
// straight back out to (tabs).

import { Stack } from "expo-router";
import React from "react";

import { colors } from "@/theme/colors";

export default function AuthLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.canvas },
      }}
    />
  );
}
