// Root layout — locks the app to the dark Orbi palette, wires up gesture
// handler at the root (required for any Reanimated worklet that responds
// to gestures later), registers the safe-area provider, and gates routes
// on auth state.

// ThemeProvider comes from expo-router now: SDK 56 dropped
// compatibility between expo-router and standalone react-navigation,
// and Metro refuses to bundle a project that depends on both.
import {
  Stack,
  ThemeProvider,
  useRouter,
  useSegments,
  type Href,
} from "expo-router";
import { StatusBar } from "expo-status-bar";
import React, { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import "react-native-reanimated";

import { useNotificationActions } from "@/hooks/useNotificationActions";
import { useRefreshOnForeground } from "@/hooks/useRefreshOnForeground";
import { usePushRegistration } from "@/hooks/usePushRegistration";
// Importing the authStore here ensures supabase.auth.onAuthStateChange is
// subscribed before any screen reads from it.
import { useAuthStore } from "@/stores/authStore";
import { useHandednessStore } from "@/stores/handednessStore";
import { useSoundStore } from "@/stores/soundStore";
import { initFeedback, setQuietHours } from "@/services/feedback";
import { useLocaleStore, type UiLanguage } from "@/i18n";
import { getMyPreferences } from "@/services/api";
import { colors } from "@/theme/colors";

// Custom React Navigation theme so headers / modals match the palette.
// dark: false now that the ground is paper — navigation uses this flag for
// its own defaults (modal backdrops, press highlights), and leaving it true
// tints them for a dark app that no longer exists.
const OrbiTheme = {
  dark: false,
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
                name="search"
                options={{ presentation: "modal", headerShown: false }}
              />
              <Stack.Screen
                name="move-task"
                options={{ presentation: "modal", headerShown: false }}
              />
              <Stack.Screen
                name="voice-action"
                options={{ presentation: "modal", headerShown: false }}
              />
              <Stack.Screen
                name="delete-account"
                options={{ presentation: "modal", headerShown: false }}
              />
              <Stack.Screen
                name="accounts"
                options={{ presentation: "modal", headerShown: false }}
              />
              <Stack.Screen
                name="account-editor"
                options={{ presentation: "modal", headerShown: false }}
              />
              <Stack.Screen
                name="recurring"
                options={{ presentation: "modal", headerShown: false }}
              />
              <Stack.Screen
                name="limits"
                options={{ presentation: "modal", headerShown: false }}
              />
              <Stack.Screen
                name="connect-bank"
                options={{ presentation: "modal", headerShown: false }}
              />
              <Stack.Screen
                name="invitations"
                options={{ presentation: "modal", headerShown: false }}
              />
              <Stack.Screen
                name="categories"
                options={{ presentation: "modal", headerShown: false }}
              />
              <Stack.Screen
                name="bank-picker"
                options={{ presentation: "modal", headerShown: false }}
              />
              <Stack.Screen
                name="movements"
                options={{ presentation: "modal", headerShown: false }}
              />
              <Stack.Screen
                name="spending"
                options={{ presentation: "modal", headerShown: false }}
              />
              <Stack.Screen
                name="insights"
                options={{ presentation: "modal", headerShown: false }}
              />
              <Stack.Screen
                name="breakdown"
                options={{ presentation: "modal", headerShown: false }}
              />

            </Stack>
          </AuthGate>
          {/* Dark glyphs, because the ground is now paper. Left as "light"
              the clock and battery are white on near-white and vanish. */}
          <StatusBar style="dark" />
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
  // Register the Done / Snooze / Reply buttons and act on them. Must be
  // mounted at the root: a response can arrive while the app is cold, and
  // a listener living on a screen isn't there to hear it.
  useNotificationActions();
  // Re-fetch when the app returns to the foreground. Screen focus does not
  // fire on background-to-foreground, so a notification action taken while
  // the app was away left the canvas showing a stale snapshot until reload.
  useRefreshOnForeground();
  // Seed UI language from the server-side preference once signed in.
  // Failure is silent and leaves English — a missing preferences row
  // is the normal state for a new user, not an error worth surfacing.
  // Audio session and cue players, once. Independent of auth: the sign-in
  // screen's buttons should feel like the rest of the app, and building a
  // player on first press adds a delay to the very tap it acknowledges.
  useEffect(() => {
    void initFeedback();
    void useSoundStore.getState().hydrate();
  }, []);

  useEffect(() => {
    if (!session) return;
    getMyPreferences()
      .then((p) => {
        useLocaleStore.getState().setLanguage(p.language as UiLanguage);
        // The app should be consistent about when it is allowed to speak, so
        // sound observes the same window that already silences reminders
        // rather than inventing a second quiet-hours setting.
        const hour = (value: string | undefined) => {
          const parsed = Number((value ?? "").slice(0, 2));
          return Number.isFinite(parsed) ? parsed : null;
        };
        setQuietHours(hour(p.quiet_hours_start), hour(p.quiet_hours_end));
        // Handedness rides along on the same call. It is a property of the
        // person rather than the handset, so a reinstall or a second device
        // should not make them find the setting again.
        if (p.handedness === "left" || p.handedness === "right") {
          useHandednessStore.getState().setHandedness(p.handedness);
        }
      })
      .catch(() => {});
  }, [session]);

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
