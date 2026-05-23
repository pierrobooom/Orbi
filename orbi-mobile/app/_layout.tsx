// Root layout — locks the app to the dark Orbi palette, wires up gesture
// handler at the root (required for any Reanimated worklet that responds
// to gestures later), registers the safe-area provider, and gates routes
// on auth state.

import { ThemeProvider } from "@react-navigation/native";
import { Stack, useRouter, useSegments, type Href } from "expo-router";
import { StatusBar } from "expo-status-bar";
import React, { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import "react-native-reanimated";

import { usePushRegistration } from "@/hooks/usePushRegistration";
// Importing the authStore here ensures supabase.auth.onAuthStateChange is
// subscribed before any screen reads from it.
import { useAuthStore } from "@/stores/authStore";
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
          <AuthGate>
            <Stack screenOptions={{ contentStyle: { backgroundColor: colors.canvas } }}>
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="(auth)" options={{ headerShown: false }} />
              <Stack.Screen
                name="new-task"
                options={{ presentation: "modal", headerShown: false }}
              />
              <Stack.Screen
                name="voice-confirm"
                options={{ presentation: "modal", headerShown: false }}
              />
              <Stack.Screen
                name="upgrade"
                options={{ presentation: "modal", headerShown: false }}
              />
              <Stack.Screen
                name="new-expense"
                options={{ presentation: "modal", headerShown: false }}
              />
              <Stack.Screen
                name="settings"
                options={{ presentation: "modal", headerShown: false }}
              />
              <Stack.Screen
                name="entry-detail"
                options={{
                  presentation: "modal",
                  headerShown: false,
                }}
              />
              <Stack.Screen
                name="task-detail"
                options={{
                  // Full-screen modal — cross-platform consistent
                  // (iOS slides up, Android full-screen). Form sheets
                  // were Apple-only, their grabber gesture ate touches
                  // near the top, and the detent system fought our
                  // flex layout. Modal gives us a normal full screen
                  // with reliable header + footer pinning.
                  presentation: "modal",
                  headerShown: false,
                }}
              />
              <Stack.Screen
                name="cluster-proposal"
                options={{ presentation: "modal", headerShown: false }}
              />
              <Stack.Screen
                name="cluster-editor"
                options={{ presentation: "modal", headerShown: false }}
              />
              <Stack.Screen
                name="modal"
                options={{ presentation: "modal", title: "Modal" }}
              />
            </Stack>
          </AuthGate>
          <StatusBar style="light" />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

// AuthGate redirects between the (auth) group and (tabs) based on session
// state. While the initial session is being loaded from SecureStore we
// render a plain splash so we never flash sign-in before redirecting back.
function AuthGate({ children }: { children: React.ReactNode }) {
  const session = useAuthStore((s) => s.session);
  const bootstrapping = useAuthStore((s) => s.bootstrapping);
  const segments = useSegments();
  const router = useRouter();
  // Kick off Expo push registration after sign-in. Hook is no-op until
  // the session is non-null, and self-guards against duplicate runs.
  usePushRegistration();

  useEffect(() => {
    if (bootstrapping) return;
    // segments[0] is typed against statically-discovered routes; cast to
    // string because the (auth) group's types are only emitted by Expo's
    // dev server after the first `expo start` run picks up the new files.
    const inAuthGroup = (segments[0] as string) === "(auth)";
    if (!session && !inAuthGroup) {
      router.replace("/(auth)/sign-in" as Href);
    } else if (session && inAuthGroup) {
      router.replace("/(tabs)" as Href);
    }
  }, [session, bootstrapping, segments, router]);

  if (bootstrapping) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.canvas, justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return <>{children}</>;
}
