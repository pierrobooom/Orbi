// Push notification registration.
//
// Asks for permission once per signed-in session, fetches the Expo push
// token, and registers it with the backend. Idempotent — calling again
// when already registered just bumps last_seen_at on the server.
//
// Expo Go vs EAS builds:
//   - Inside Expo Go the projectId is injected at runtime, so omitting
//     it from getExpoPushTokenAsync is the correct call there.
//   - In an EAS dev/production build we read the projectId from
//     Constants. If it's missing we log and bail rather than crash.

import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";

import {
  ApiError,
  registerPushToken,
  unregisterPushToken,
  type DevicePlatform,
} from "@/services/api";
import { useAuthStore } from "@/stores/authStore";

// Global foreground handler. Default behaviour in iOS Expo Go suppresses
// the banner when the app is in the foreground; flipping these on means
// the user sees the same banner whether the app is open or backgrounded.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// The token this phone registered for the signed-in user, if any.
let registeredToken: string | null = null;

/** Detach this phone from the account before signing out.
 *
 * Without it the server kept sending the signed-out user's reminders — task
 * titles included — to this phone, to whoever used it next. Best effort and
 * time-boxed: it needs the network and the session, and signing out must
 * work offline. The server also hands a token to whoever registers it last,
 * so a missed call here is corrected by the next sign-in.
 */
export async function unregisterPushDevice(): Promise<void> {
  const token = registeredToken;
  if (!token) return;
  registeredToken = null;
  await Promise.race([
    unregisterPushToken(token).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

function resolveProjectId(): string | undefined {
  // Both paths can be missing during Expo Go dev — the native module
  // injects its own projectId there, so passing undefined is OK.
  return (
    Constants.expoConfig?.extra?.eas?.projectId ??
    (Constants as unknown as { easConfig?: { projectId?: string } }).easConfig?.projectId
  );
}

/** Standalone registration call — used by the hook and by the Dev tools
 * "Register push device" button so errors can be surfaced visibly. */
export async function registerPushDevice(): Promise<
  | { ok: true; token: string }
  | { ok: false; reason: string }
> {
  try {
    const perm = await Notifications.getPermissionsAsync();
    let granted = perm.granted;
    if (!granted) {
      const next = await Notifications.requestPermissionsAsync();
      granted = next.granted;
    }
    if (!granted) {
      return { ok: false, reason: "Notification permission denied. Enable in iOS Settings → Expo Go → Notifications." };
    }

    const projectId = resolveProjectId();
    const tokenResp = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    const token = tokenResp?.data;
    if (!token || typeof token !== "string" || token.length === 0) {
      return {
        ok: false,
        reason: `Expo returned an empty push token (data=${JSON.stringify(tokenResp)}). projectId=${projectId ?? "<undefined>"}`,
      };
    }

    const platform: DevicePlatform =
      Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : "web";

    await registerPushToken(token, platform);
    registeredToken = token;
    return { ok: true, token };
  } catch (e) {
    const msg = e instanceof ApiError ? `Backend ${e.status}: ${e.message}` : String(e);
    return { ok: false, reason: msg };
  }
}

export function usePushRegistration() {
  const session = useAuthStore((s) => s.session);
  // One attempt per signed-in user — track the user id we registered
  // against so a sign-out / sign-in cycle triggers a fresh registration
  // for the new user.
  const lastRegisteredFor = useRef<string | null>(null);

  useEffect(() => {
    const userId = session?.user?.id ?? null;
    if (!userId) {
      lastRegisteredFor.current = null;
      return;
    }
    if (lastRegisteredFor.current === userId) return;

    let cancelled = false;
    (async () => {
      const result = await registerPushDevice();
      if (cancelled) return;
      if (result.ok) {
        lastRegisteredFor.current = userId;
      } else {
        // eslint-disable-next-line no-console
        console.warn("Push registration failed:", result.reason);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session]);
}
