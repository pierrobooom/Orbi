// Root layout — locks the app to the dark Orbi palette, wires up gesture
// handler at the root (required for any Reanimated worklet that responds
// to gestures later), and registers the safe-area provider.

import { ThemeProvider } from "@react-navigation/native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import "react-native-reanimated";

import { colors } from "@/theme/colors";

// Custom React Navigation theme so headers / modals match the sketch.
const OrbiTheme = {
  dark: true,
  colors: {
    primary: colors.accent,
    background: colors.canvas,
    card: colors.panel,
    text: colors.ink,
    border: colors.line,
    notification: colors.overdue,
  },
  fonts: {
    regular: { fontFamily: "System", fontWeight: "400" as const },
    medium: { fontFamily: "System", fontWeight: "500" as const },
    bold: { fontFamily: "System", fontWeight: "700" as const },
    heavy: { fontFamily: "System", fontWeight: "800" as const },
  },
};

export const unstable_settings = {
  anchor: "(tabs)",
};

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.canvas }}>
      <SafeAreaProvider>
        <ThemeProvider value={OrbiTheme}>
          <Stack screenOptions={{ contentStyle: { backgroundColor: colors.canvas } }}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen
              name="modal"
              options={{ presentation: "modal", title: "Modal" }}
            />
          </Stack>
          <StatusBar style="light" />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
