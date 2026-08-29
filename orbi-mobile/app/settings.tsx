// Settings modal — opened by tapping the tier pill on the Universe.
//
// Houses everything that doesn't earn a dedicated tab: profile name,
// notifications toggle, tier (links to upgrade modal), prominent
// Sign out, and Dev tools (push register + test push) which used to
// live in the upgrade modal.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as Notifications from "expo-notifications";
import { useRouter, type Href } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { registerPushDevice } from "@/hooks/usePushRegistration";
import {
  API_BASE_URL,
  ApiError,
  getHealth,
  getMyPreferences,
  sendTestPush,
  setMyPreferences,
  SUPPORTED_LANGUAGES,
  type LanguageTag,
  type UserPreferences,
} from "@/services/api";
import { TIER_DISPLAY } from "@/services/tierGate";
import { useAuthStore } from "@/stores/authStore";
import { colors } from "@/theme/colors";

// Backend reachability is shown in a dedicated Status section. Lives
// here (and not on the canvas header) because it's debug-y context
// the user only needs when something feels wrong.
type HealthStatus =
  | { kind: "loading" }
  | { kind: "ok"; app: string; latencyMs: number }
  | { kind: "error"; message: string };

export default function SettingsScreen() {
  const router = useRouter();
  const session = useAuthStore((s) => s.session);
  const tier = useAuthStore((s) => s.tier);
  const signOut = useAuthStore((s) => s.signOut);

  const email = session?.user?.email ?? "—";

  const [notifsGranted, setNotifsGranted] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<"signout" | "test" | "register" | null>(null);
  const [health, setHealth] = useState<HealthStatus>({ kind: "loading" });
  // Language lives in user_preferences server-side; it drives speech
  // recognition, which language the agents reply in, and how titles
  // are cleaned up. Null until the first fetch resolves.
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);
  const [savingLanguage, setSavingLanguage] = useState<LanguageTag | null>(null);
  const [languageError, setLanguageError] = useState<string | null>(null);

  useEffect(() => {
    Notifications.getPermissionsAsync()
      .then((p) => setNotifsGranted(p.granted))
      .catch(() => setNotifsGranted(null));
  }, []);

  // Ping the backend on mount + when the user taps "Recheck". Latency
  // is useful debug context if a request feels slow.
  const checkHealth = () => {
    setHealth({ kind: "loading" });
    const startedAt = Date.now();
    getHealth()
      .then((r) =>
        setHealth({ kind: "ok", app: r.app, latencyMs: Date.now() - startedAt }),
      )
      .catch((e) =>
        setHealth({ kind: "error", message: String(e?.message ?? e) }),
      );
  };

  useEffect(() => {
    checkHealth();
  }, []);

  const onToggleNotifs = async (next: boolean) => {
    if (next) {
      // Try to upgrade permission. iOS only shows the prompt once per
      // app install; subsequent declines need a Settings trip.
      const result = await Notifications.requestPermissionsAsync();
      setNotifsGranted(result.granted);
      if (!result.granted) {
        Alert.alert(
          "Enable in iOS Settings",
          "Notifications were declined earlier. Enable them in iOS Settings → Expo Go → Notifications.",
          [
            { text: "Cancel", style: "cancel" },
            { text: "Open Settings", onPress: () => Linking.openSettings() },
          ],
        );
      } else {
        // Permission just granted — re-register the device so the
        // backend has the token immediately.
        const r = await registerPushDevice();
        if (!r.ok) {
          Alert.alert("Registration failed", r.reason);
        }
      }
    } else {
      // iOS doesn't let an app revoke its own notification permission.
      Alert.alert(
        "Disable in iOS Settings",
        "iOS handles notification permissions itself. Disable them in Settings → Expo Go → Notifications.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Open Settings", onPress: () => Linking.openSettings() },
        ],
      );
    }
  };

  useEffect(() => {
    // A user who has never opened preferences has no row yet; the
    // backend 404s rather than auto-creating one, so fall back to the
    // same defaults the DB column uses.
    getMyPreferences()
      .then(setPrefs)
      .catch(() => {
        setPrefs({
          user_id: "",
          quiet_hours_start: "22:00:00",
          quiet_hours_end: "08:00:00",
          proactivity_level: 3,
          preferred_reminder_channel: "push",
          language: "en-GB",
        });
      });
  }, []);

  const onSelectLanguage = async (tag: LanguageTag) => {
    if (!prefs || prefs.language === tag) return;
    setLanguageError(null);
    setSavingLanguage(tag);
    const previous = prefs;
    // Optimistic — the row highlights immediately and reverts on failure.
    setPrefs({ ...prefs, language: tag });
    try {
      // Only the changed field — the server merges over the stored row.
      const saved = await setMyPreferences({ language: tag });
      setPrefs(saved);
    } catch (e) {
      setPrefs(previous);
      setLanguageError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSavingLanguage(null);
    }
  };

  const onSignOut = async () => {
    Alert.alert("Sign out?", "You'll need to sign back in to use Orbi.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: async () => {
          setBusy("signout");
          await signOut();
          setBusy(null);
          // AuthGate redirects to /(auth)/sign-in on session=null.
        },
      },
    ]);
  };

  const onTestPush = async () => {
    setBusy("test");
    try {
      const result = await sendTestPush();
      Alert.alert(
        "Test push sent",
        `Pushed to ${result.sent} device${result.sent === 1 ? "" : "s"}.`,
      );
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      Alert.alert("Test push failed", msg);
    } finally {
      setBusy(null);
    }
  };

  const onRegisterDevice = async () => {
    setBusy("register");
    const result = await registerPushDevice();
    setBusy(null);
    if (result.ok) {
      Alert.alert("Device registered", `Token: …${result.token.slice(-12)}`);
    } else {
      Alert.alert("Registration failed", result.reason);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.headerCancel}>Done</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={{ width: 50 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Section title="Profile">
          <Row label="Email" value={email} />
          <Row label="Plan" value={TIER_DISPLAY[tier]} />
          <Pressable
            onPress={() => router.push("/upgrade" as Href)}
            style={styles.link}
          >
            <Text style={styles.linkText}>See plans →</Text>
          </Pressable>
        </Section>

        <Section title="Universe">
          <Pressable
            onPress={() => router.push("/cluster-proposal" as Href)}
            style={styles.universeRow}
          >
            <View style={styles.toggleLabelGroup}>
              <Text style={styles.rowLabel}>Organise clusters</Text>
              <Text style={styles.rowHint}>
                Ask Orbi to suggest cluster merges, moves, and new groupings.
              </Text>
            </View>
            <MaterialIcons name="chevron-right" size={22} color={colors.inkDim} />
          </Pressable>
          <Pressable
            onPress={() => router.push("/cluster-editor?id=new" as Href)}
            style={styles.universeRow}
          >
            <View style={styles.toggleLabelGroup}>
              <Text style={styles.rowLabel}>New cluster</Text>
              <Text style={styles.rowHint}>
                Create a cluster manually. Tip: long-press the + button on the
                canvas for the same thing, and long-press a cluster bubble to
                rename, recolor, or delete it.
              </Text>
            </View>
            <MaterialIcons name="chevron-right" size={22} color={colors.inkDim} />
          </Pressable>
        </Section>

        <Section title="Notifications">
          <View style={styles.toggleRow}>
            <View style={styles.toggleLabelGroup}>
              <Text style={styles.rowLabel}>Push notifications</Text>
              <Text style={styles.rowHint}>
                {notifsGranted === null
                  ? "Checking permission…"
                  : notifsGranted
                    ? "Reminders can reach you on this device."
                    : "Off — turn on to receive reminders."}
              </Text>
            </View>
            <Switch
              value={notifsGranted === true}
              onValueChange={onToggleNotifs}
              disabled={notifsGranted === null}
              trackColor={{ false: colors.line, true: colors.accent }}
            />
          </View>
        </Section>

        <Section title="Language">
          <Text style={styles.languageHint}>
            Used for speech recognition and for the language Orbi replies in.
          </Text>
          {SUPPORTED_LANGUAGES.map((option) => {
            const active = prefs?.language === option.tag;
            return (
              <Pressable
                key={option.tag}
                onPress={() => onSelectLanguage(option.tag)}
                disabled={savingLanguage !== null || prefs === null}
                style={[styles.languageRow, active && styles.languageRowActive]}
              >
                <Text
                  style={[styles.languageLabel, active && styles.languageLabelActive]}
                >
                  {option.label}
                </Text>
                {savingLanguage === option.tag ? (
                  <ActivityIndicator size="small" color={colors.inkDim} />
                ) : active ? (
                  <Text style={styles.languageCheck}>✓</Text>
                ) : null}
              </Pressable>
            );
          })}
          {prefs === null ? (
            <Text style={styles.languageHint}>Loading…</Text>
          ) : null}
          {languageError ? (
            <Text style={styles.languageError}>{languageError}</Text>
          ) : null}
        </Section>

        <Section title="Status">
          <View style={styles.statusRow}>
            <View style={styles.statusDotWrap}>
              <View
                style={[
                  styles.statusDot,
                  health.kind === "ok" && styles.statusDotOk,
                  health.kind === "error" && styles.statusDotErr,
                ]}
              />
            </View>
            <View style={styles.toggleLabelGroup}>
              <Text style={styles.rowLabel}>
                {health.kind === "loading" && "Checking backend…"}
                {health.kind === "ok" && "Backend reachable"}
                {health.kind === "error" && "Backend unreachable"}
              </Text>
              <Text style={styles.rowHint}>
                {health.kind === "ok"
                  ? `${health.app} • ${health.latencyMs} ms`
                  : health.kind === "error"
                    ? health.message
                    : "Pinging /health…"}
              </Text>
            </View>
            <Pressable onPress={checkHealth} hitSlop={8} style={styles.statusRecheck}>
              <MaterialIcons name="refresh" size={20} color={colors.inkDim} />
            </Pressable>
          </View>
          <View style={styles.statusRow}>
            <View style={styles.statusDotWrap}>
              <MaterialIcons name="dns" size={16} color={colors.inkDim} />
            </View>
            <View style={styles.toggleLabelGroup}>
              <Text style={styles.rowLabel}>API endpoint</Text>
              <Text style={styles.rowHint} numberOfLines={1}>
                {API_BASE_URL}
              </Text>
            </View>
          </View>
        </Section>

        <Section title="Dev tools">
          <Pressable
            onPress={onRegisterDevice}
            disabled={busy !== null}
            style={[styles.toolBtn, busy && styles.toolBtnBusy]}
          >
            {busy === "register" ? (
              <ActivityIndicator color={colors.ink} />
            ) : (
              <Text style={styles.toolBtnText}>Register push device</Text>
            )}
          </Pressable>
          <Pressable
            onPress={onTestPush}
            disabled={busy !== null}
            style={[styles.toolBtn, busy && styles.toolBtnBusy, styles.toolBtnSpaced]}
          >
            {busy === "test" ? (
              <ActivityIndicator color={colors.ink} />
            ) : (
              <Text style={styles.toolBtnText}>Send test push</Text>
            )}
          </Pressable>
          <Text style={styles.rowHint}>Removed before launch.</Text>
        </Section>

        <Pressable
          onPress={onSignOut}
          disabled={busy !== null}
          style={[styles.signOut, busy && styles.toolBtnBusy]}
        >
          {busy === "signout" ? (
            <ActivityIndicator color={colors.overdue} />
          ) : (
            <Text style={styles.signOutText}>Sign out</Text>
          )}
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  headerTitle: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  headerCancel: { color: colors.accent, fontSize: 14, fontWeight: "600", width: 50 },
  body: { padding: 20, paddingBottom: 60 },
  section: { marginBottom: 22 },
  languageRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 13,
    paddingHorizontal: 16,
  },
  languageRowActive: { backgroundColor: colors.panel },
  languageLabel: { color: colors.ink, fontSize: 14 },
  languageLabelActive: { fontWeight: "700" },
  languageCheck: { color: colors.accent, fontSize: 15, fontWeight: "700" },
  languageHint: {
    color: colors.inkDim,
    fontSize: 11,
    lineHeight: 16,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  languageError: {
    color: colors.overdue,
    fontSize: 12,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  sectionTitle: {
    color: colors.inkDim,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  sectionBody: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 4,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 12,
    gap: 12,
  },
  rowLabel: { color: colors.ink, fontSize: 14, fontWeight: "500" },
  rowValue: { color: colors.inkDim, fontSize: 13, flexShrink: 1, textAlign: "right" },
  rowHint: { color: colors.inkDim, fontSize: 11, marginTop: 8, paddingHorizontal: 2, lineHeight: 15 },
  link: { paddingVertical: 10 },
  linkText: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    gap: 12,
  },
  toggleLabelGroup: { flex: 1 },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    gap: 12,
  },
  statusDotWrap: { width: 18, alignItems: "center" },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.inkDim,
  },
  statusDotOk: { backgroundColor: colors.health },
  statusDotErr: { backgroundColor: colors.overdue },
  statusRecheck: { padding: 4 },
  universeRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    gap: 12,
  },
  toolBtn: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: colors.canvas,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    alignItems: "center",
  },
  toolBtnBusy: { opacity: 0.6 },
  toolBtnSpaced: { marginTop: 10 },
  toolBtnText: { color: colors.ink, fontSize: 14, fontWeight: "600" },
  signOut: {
    marginTop: 8,
    paddingVertical: 14,
    borderRadius: 12,
    borderColor: colors.overdue,
    borderWidth: 1,
    alignItems: "center",
  },
  signOutText: { color: colors.overdue, fontSize: 15, fontWeight: "700" },
});
