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
import { useFonts } from "expo-font";
import React, { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import "react-native-reanimated";

import { useNotificationActions } from "@/hooks/useNotificationActions";
import { useRefreshOnForeground } from "@/hooks/useRefreshOnForeground";
import { useDueClock } from "@/hooks/useDueClock";
import { usePushRegistration } from "@/hooks/usePushRegistration";
// Importing the authStore here ensures supabase.auth.onAuthStateChange is
// subscribed before any screen reads from it.
import { useAuthStore } from "@/stores/authStore";
import { useHandednessStore } from "@/stores/handednessStore";
import { useSoundStore } from "@/stores/soundStore";
import { useThemeStore } from "@/stores/themeStore";
import { useUniverseStore } from "@/stores/universeStore";
import { initFeedback, setQuietHours } from "@/services/feedback";
import { useLocaleStore, type UiLanguage } from "@/i18n";
import { getMyPreferences } from "@/services/api";
import { colors } from "@/theme/colors";
import { FONT_ASSETS } from "@/theme/fonts";

// Navigation's own theme, built at render rather than at import: a module
// constant would hold whichever palette was live when the file loaded and
// never follow night mode. `dark` drives navigation's defaults — modal
// backdrops, press highlights — so it has to track the palette too.
function navigationTheme(isNight: boolean) {
  return {
    dark: isNight,
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
}

export const unstable_settings = {
  anchor: "(tabs)",
};

export default function RootLayout() {
  // Waited for rather than swapped in. The display face is only used for a
  // few large numbers, and a figure that re-renders from the system font
  // into a serif a moment after the screen appears reads as the number
  // changing. Bundled with the app, so this resolves in milliseconds.
  const [fontsLoaded, fontError] = useFonts(FONT_ASSETS);

  // The theme is read before the first frame, like the font. Rendering first
  // would paint the light palette and then swap — a white flash at night for
  // exactly the people who asked for it not to be white.
  const themeReady = useThemeStore((s) => s.ready);
  const themeVersion = useThemeStore((s) => s.version);
  const isNight = useThemeStore((s) => s.resolved === "night");
  useEffect(() => {
    void useThemeStore.getState().hydrate();
  }, []);
  // The universe layout bakes each cluster's fallback colour in when it is
  // built, so a palette change has to rebuild it — from memory, no request.
  useEffect(() => {
    if (themeVersion > 1) useUniverseStore.getState().relayout();
  }, [themeVersion]);

  if ((!fontsLoaded && !fontError) || !themeReady) {
    return <View style={{ flex: 1, backgroundColor: colors.canvas }} />;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.canvas }}>
      <SafeAreaProvider>
        <ThemeProvider value={navigationTheme(isNight)}>
          <AuthGate>
            {/* On a theme change every screen's CONTENT remounts, so it
                re-reads colours and styles — keyed on the palette version.
                The navigator is not remounted, so the stack of open screens
                survives and you stay exactly where you were. (tabs) is left
                alone here: remounting it would reset which tab is open, so
                the tabs navigator does the same thing for its own screens. */}
            <Stack
              screenOptions={{ contentStyle: { backgroundColor: colors.canvas } }}
              screenLayout={({ route, children }) =>
                route.name === "(tabs)" ? (
                  children
                ) : (
                  <React.Fragment key={themeVersion}>{children}</React.Fragment>
                )
              }
            >
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
          {/* Dark glyphs on paper, light ones at night — the wrong way round
              and the clock and battery vanish into the background. */}
          <StatusBar style={isNight ? "light" : "dark"} />
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
  // Redraw the moment a task becomes overdue, whichever tab is open.
  useDueClock();
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
