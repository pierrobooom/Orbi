// Settings modal — opened by tapping the tier pill on the Universe.
//
// Houses everything that doesn't earn a dedicated tab: profile name,
// notifications toggle, tier (links to upgrade modal), prominent
// Sign out, and Dev tools (push register + test push) which used to
// live in the upgrade modal.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as Notifications from "expo-notifications";
import { useRouter, type Href } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
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
  DEFAULT_PREFERENCES,
  getHealth,
  getMyPreferences,
  REMINDER_DENSITY,
  sendTestPush,
  setMyPreferences,
  SUPPORTED_LANGUAGES,
  type LanguageTag,
  type UserPreferences,
  type UserPreferencesPatch,
} from "@/services/api";
import { TIER_DISPLAY } from "@/services/tierGate";
import { useAuthStore } from "@/stores/authStore";
import { useLocaleStore, useT, type UiLanguage, translate } from "@/i18n";
import {
  useHandednessStore,
  type Handedness,
} from "@/stores/handednessStore";
import { colors } from "@/theme/colors";

// Backend reachability is shown in a dedicated Status section. Lives
// here (and not on the canvas header) because it's debug-y context
// the user only needs when something feels wrong.
type HealthStatus =
  | { kind: "loading" }
  | { kind: "ok"; app: string; latencyMs: number }
  | { kind: "error"; message: string };

/** "22:00:00" -> "22:00". The seconds are always zero and only add noise. */
function toDisplayTime(value: string): string {
  return (value || "").slice(0, 5);
}

/** "22:00:00" -> a Date today at that wall-clock time, for the picker. */
function toPickerDate(value: string): Date {
  const [hours, minutes] = toDisplayTime(value).split(":").map(Number);
  const date = new Date();
  date.setHours(hours || 0, minutes || 0, 0, 0);
  return date;
}

function fromPickerDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
}

/** The device's IANA zone, or null if the runtime won't say.
 *
 * The server needs this to interpret quiet hours: they are stored as
 * zone-less times, and the background dispatcher has no request to read a
 * zone from the way the chat endpoints do. */
function deviceTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export default function SettingsScreen() {
  const t = useT();
  const router = useRouter();
  const session = useAuthStore((s) => s.session);
  const tier = useAuthStore((s) => s.tier);
  const signOut = useAuthStore((s) => s.signOut);

  const email = session?.user?.email ?? "—";

  const handedness = useHandednessStore((s) => s.handedness);
  const setHandedness = useHandednessStore((s) => s.setHandedness);

  const [notifsGranted, setNotifsGranted] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<"signout" | "test" | "register" | null>(null);
  const [health, setHealth] = useState<HealthStatus>({ kind: "loading" });
  // Language lives in user_preferences server-side; it drives speech
  // recognition, which language the agents reply in, and how titles
  // are cleaned up. Null until the first fetch resolves.
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);
  const [savingLanguage, setSavingLanguage] = useState<LanguageTag | null>(null);
  const [languageError, setLanguageError] = useState<string | null>(null);
  const [savingHand, setSavingHand] = useState<Handedness | null>(null);
  const [prefsError, setPrefsError] = useState<string | null>(null);
  // Which quiet-hours bound the picker is editing, if any.
  const [editingQuiet, setEditingQuiet] = useState<"start" | "end" | null>(null);
  // Serialises preference writes and identifies the newest one. See
  // savePrefs for why both are needed.
  const saveSeq = useRef(0);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  // Mirrors `prefs` for the revert path, which runs inside a chained
  // callback where the closure's copy is stale by definition.
  const prefsRef = useRef<UserPreferences | null>(null);
  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

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
        Alert.alert(translate("Enable in iOS Settings"), translate("Notifications were declined earlier. Enable them in iOS Settings → Expo Go → Notifications."),
          [
            { text: translate("Cancel"), style: "cancel" },
            { text: "Open Settings", onPress: () => Linking.openSettings() },
          ],
        );
      } else {
        // Permission just granted — re-register the device so the
        // backend has the token immediately.
        const r = await registerPushDevice();
        if (!r.ok) {
          Alert.alert(translate("Registration failed"), r.reason);
        }
      }
    } else {
      // iOS doesn't let an app revoke its own notification permission.
      Alert.alert(translate("Disable in iOS Settings"), translate("iOS handles notification permissions itself. Disable them in Settings → Expo Go → Notifications."),
        [
          { text: translate("Cancel"), style: "cancel" },
          { text: "Open Settings", onPress: () => Linking.openSettings() },
        ],
      );
    }
  };

  useEffect(() => {
    // A user who has never opened preferences has no row yet; the
    // backend 404s rather than auto-creating one, so fall back to the
    // same defaults the DB columns use.
    getMyPreferences()
      .then((loaded) => {
        setPrefs(loaded);
        // Push the device's zone up if the server is holding a stale one
        // (or the UTC default). Without it, quiet hours are interpreted in
        // the wrong zone and reminders land at the wrong hour — and this
        // screen is the only place that knows where the phone is.
        const zone = deviceTimezone();
        if (zone && zone !== loaded.timezone) {
          setMyPreferences({ timezone: zone })
            .then(setPrefs)
            .catch(() => {
              /* non-fatal — the server falls back to UTC */
            });
        }
      })
      .catch(() => {
        setPrefs({
          ...DEFAULT_PREFERENCES,
          timezone: deviceTimezone() ?? DEFAULT_PREFERENCES.timezone,
        });
      });
  }, []);

  /** Save one or more preference fields, optimistically.
   *
   * The row reflects the change immediately and reverts if the save fails,
   * which matters for switches: a toggle that animates on and then silently
   * isn't saved is worse than one that visibly snaps back.
   *
   * Flipping a switch twice quickly used to leave it stuck on whichever
   * value happened to reply LAST rather than whichever was pressed last —
   * two PUTs would be in flight at once, and neither the server's ordering
   * nor the responses' were guaranteed to match the order of the taps. So:
   *
   *   - saves are chained, never concurrent, so the server applies them in
   *     the order they were pressed and the database ends up on the last
   *     one;
   *   - each save carries a sequence number and only the newest is allowed
   *     to write the response back into state, so a slow earlier reply
   *     can't overwrite a newer optimistic value;
   *   - the optimistic update is a functional setState, because `prefs`
   *     captured in this closure is already stale by the second tap.
   */
  const savePrefs = (patch: UserPreferencesPatch) => {
    if (!prefs) return;
    const seq = ++saveSeq.current;
    setPrefsError(null);
    setPrefs((current) =>
      current ? ({ ...current, ...patch } as UserPreferences) : current,
    );

    saveChain.current = saveChain.current
      .then(async () => {
        const previous = prefsRef.current;
        try {
          const saved = await setMyPreferences(patch);
          if (seq === saveSeq.current) setPrefs(saved);
        } catch (e) {
          if (seq === saveSeq.current) {
            if (previous) setPrefs(previous);
            setPrefsError(e instanceof ApiError ? e.message : String(e));
          }
        }
      })
      // The chain must survive a failed link or every later save is
      // dropped with it.
      .catch(() => {});
  };

  /** Flip which side the reachable controls sit on.
   *
   * Applied locally before the save so the layout moves under the finger
   * that pressed it — a setting about reachability that takes a round trip
   * to show anything reads as not having worked.
   */
  const onSelectHandedness = async (hand: Handedness) => {
    if (handedness === hand) return;
    setSavingHand(hand);
    const previous = handedness;
    setHandedness(hand);
    try {
      setPrefs(await setMyPreferences({ handedness: hand }));
    } catch {
      setHandedness(previous);
    } finally {
      setSavingHand(null);
    }
  };

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
      // Switch the UI too — the setting reads as "app language", so
      // leaving the chrome in English after a successful save looks
      // like the save silently failed.
      useLocaleStore.getState().setLanguage(saved.language as UiLanguage);
    } catch (e) {
      setPrefs(previous);
      setLanguageError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSavingLanguage(null);
    }
  };

  const onSignOut = async () => {
    Alert.alert(translate("Sign out?"), translate("You'll need to sign back in to use Orbi."), [
      { text: translate("Cancel"), style: "cancel" },
      {
        text: translate("Sign out"),
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
      Alert.alert(translate("Test push sent"),
        `Pushed to ${result.sent} device${result.sent === 1 ? "" : "s"}.`,
      );
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      Alert.alert(translate("Test push failed"), msg);
    } finally {
      setBusy(null);
    }
  };

  const onRegisterDevice = async () => {
    setBusy("register");
    const result = await registerPushDevice();
    setBusy(null);
    if (result.ok) {
      Alert.alert(translate("Device registered"), `Token: …${result.token.slice(-12)}`);
    } else {
      Alert.alert(translate("Registration failed"), result.reason);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.headerCancel} numberOfLines={1}>{t("Done")}</Text>
        </Pressable>
        <Text style={styles.headerTitle}>{t("Settings")}</Text>
        <View style={{ minWidth: 64 }} />
      </View>

      <ScrollView
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
        <Section title={t("Profile")}>
          <Row label={t("Email")} value={email} />
          <Row label={t("Plan")} value={TIER_DISPLAY[tier]} />
          <Pressable
            onPress={() => router.push("/upgrade" as Href)}
            style={styles.link}
          >
            <Text style={styles.linkText}>{t("See plans →")}</Text>
          </Pressable>
        </Section>

        <Section title={t("Universe")}>
          <Pressable
            onPress={() => router.push("/cluster-proposal" as Href)}
            style={styles.universeRow}
          >
            <View style={styles.toggleLabelGroup}>
              <Text style={styles.rowLabel}>{t("Organise clusters")}</Text>
              <Text style={styles.rowHint}>
                {t("Ask Orbi to suggest cluster merges, moves, and new groupings.")}
              </Text>
            </View>
            <MaterialIcons name="chevron-right" size={22} color={colors.inkDim} />
          </Pressable>
          <Pressable
            onPress={() => router.push("/cluster-editor?id=new" as Href)}
            style={styles.universeRow}
          >
            <View style={styles.toggleLabelGroup}>
              <Text style={styles.rowLabel}>{t("New cluster")}</Text>
              <Text style={styles.rowHint}>
                Create a cluster manually. Tip: long-press the + button on the
                canvas for the same thing, and long-press a cluster bubble to
                rename, recolor, or delete it.
              </Text>
            </View>
            <MaterialIcons name="chevron-right" size={22} color={colors.inkDim} />
          </Pressable>
        </Section>

        <Section title={t("Notifications")}>
          <View style={styles.toggleRow}>
            <View style={styles.toggleLabelGroup}>
              <Text style={styles.rowLabel}>{t("Push notifications")}</Text>
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

        <Section title={t("Reminders")}>
          <View style={styles.toggleRow}>
            <View style={styles.toggleLabelGroup}>
              <Text style={styles.rowLabel}>{t("Remind me about tasks")}</Text>
              <Text style={styles.rowHint}>
                {t("Orbi schedules nudges around each task's deadline.")}
              </Text>
            </View>
            <Switch
              value={prefs?.reminders_enabled ?? true}
              onValueChange={(v) => savePrefs({ reminders_enabled: v })}
              disabled={prefs === null}
              trackColor={{ false: colors.line, true: colors.accent }}
            />
          </View>

          {prefs?.reminders_enabled !== false ? (
            <>
              <View style={styles.toggleRow}>
                <View style={styles.toggleLabelGroup}>
                  <Text style={styles.rowLabel}>{t("Before the deadline")}</Text>
                  <Text style={styles.rowHint}>
                    {t("A heads-up so it doesn't sneak up on you. Important tasks get more warning.")}
                  </Text>
                </View>
                <Switch
                  value={prefs?.lead_reminders_enabled ?? true}
                  onValueChange={(v) => savePrefs({ lead_reminders_enabled: v })}
                  disabled={prefs === null}
                  trackColor={{ false: colors.line, true: colors.accent }}
                />
              </View>

              <View style={styles.toggleRow}>
                <View style={styles.toggleLabelGroup}>
                  <Text style={styles.rowLabel}>{t("After the deadline")}</Text>
                  <Text style={styles.rowHint}>
                    {t("Asks whether you got it done, so it can be ticked off or postponed.")}
                  </Text>
                </View>
                <Switch
                  value={prefs?.chase_reminders_enabled ?? true}
                  onValueChange={(v) => savePrefs({ chase_reminders_enabled: v })}
                  disabled={prefs === null}
                  trackColor={{ false: colors.line, true: colors.accent }}
                />
              </View>

              <View style={styles.densityBlock}>
                <Text style={styles.rowLabel}>{t("How much")}</Text>
                <View style={styles.densityRow}>
                  {[1, 2, 3, 4, 5].map((level) => {
                    const active = (prefs?.proactivity_level ?? 3) === level;
                    return (
                      <Pressable
                        key={level}
                        onPress={() => savePrefs({ proactivity_level: level })}
                        disabled={prefs === null}
                        style={[styles.densityPip, active && styles.densityPipActive]}
                      >
                        <Text
                          style={[
                            styles.densityPipText,
                            active && styles.densityPipTextActive,
                          ]}
                        >
                          {level}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Text style={styles.rowHint}>
                  {t("{label} — at most {n} notifications a day. Anything over the limit is dropped, least urgent first.", {
                    label: t(REMINDER_DENSITY[prefs?.proactivity_level ?? 3].label),
                    n: REMINDER_DENSITY[prefs?.proactivity_level ?? 3].perDay,
                  })}
                </Text>
              </View>

              <Pressable
                onPress={() => setEditingQuiet("start")}
                disabled={prefs === null}
                style={styles.quietRow}
              >
                <Text style={styles.rowLabel}>{t("Quiet from")}</Text>
                <Text style={styles.quietValue}>
                  {toDisplayTime(prefs?.quiet_hours_start ?? "22:00:00")}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setEditingQuiet("end")}
                disabled={prefs === null}
                style={styles.quietRow}
              >
                <Text style={styles.rowLabel}>{t("Quiet until")}</Text>
                <Text style={styles.quietValue}>
                  {toDisplayTime(prefs?.quiet_hours_end ?? "08:00:00")}
                </Text>
              </Pressable>
              <Text style={styles.rowHint}>
                {t("Nothing arrives during these hours. A reminder that falls inside waits for the morning rather than being lost.")}
              </Text>

              {editingQuiet && prefs ? (
                <DateTimePicker
                  value={toPickerDate(
                    editingQuiet === "start"
                      ? prefs.quiet_hours_start
                      : prefs.quiet_hours_end,
                  )}
                  mode="time"
                  display={Platform.OS === "ios" ? "spinner" : "default"}
                  themeVariant="dark"
                  // Same migration off the deprecated `onChange`
                  // multiplexer as new-task.tsx and voice-confirm.tsx.
                  onValueChange={(_event, date) => {
                    if (Platform.OS === "android") setEditingQuiet(null);
                    if (!date) return;
                    savePrefs(
                      editingQuiet === "start"
                        ? { quiet_hours_start: fromPickerDate(date) }
                        : { quiet_hours_end: fromPickerDate(date) },
                    );
                  }}
                  onDismiss={() => setEditingQuiet(null)}
                />
              ) : null}

              {Platform.OS === "ios" && editingQuiet ? (
                <Pressable
                  onPress={() => setEditingQuiet(null)}
                  style={styles.quietDoneRow}
                >
                  <Text style={styles.linkText}>{t("Done")}</Text>
                </Pressable>
              ) : null}
            </>
          ) : null}

          {prefsError ? (
            <Text style={styles.languageError}>{prefsError}</Text>
          ) : null}
        </Section>

        <Section title={t("Language")}>
          <Text style={styles.languageHint}>
            {t("Used for speech recognition and for the language Orbi replies in.")}
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
            <Text style={styles.languageHint}>{t("Loading…")}</Text>
          ) : null}
          {languageError ? (
            <Text style={styles.languageError}>{languageError}</Text>
          ) : null}
        </Section>

        {/* Which hand holds the phone.
            Both top corners sit outside a thumb's arc, but the far one is
            the unreachable one — and which corner is far depends entirely
            on the hand. The app had no way to know, so it guessed the same
            way for everybody. */}
        <Section title={t("Handedness")}>
          <Text style={styles.languageHint}>
            {t(
              "Moves buttons to the side your thumb reaches. Nothing changes what they do.",
            )}
          </Text>
          {(["right", "left"] as const).map((hand) => {
            const active = handedness === hand;
            return (
              <Pressable
                key={hand}
                onPress={() => onSelectHandedness(hand)}
                disabled={savingHand !== null || prefs === null}
                style={[styles.languageRow, active && styles.languageRowActive]}
              >
                <Text
                  style={[styles.languageLabel, active && styles.languageLabelActive]}
                >
                  {hand === "right" ? t("Right-handed") : t("Left-handed")}
                </Text>
                {savingHand === hand ? (
                  <ActivityIndicator size="small" color={colors.inkDim} />
                ) : active ? (
                  <Text style={styles.languageCheck}>✓</Text>
                ) : null}
              </Pressable>
            );
          })}
        </Section>

        <Section title={t("Status")}>
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
              <Text style={styles.rowLabel}>{t("API endpoint")}</Text>
              <Text style={styles.rowHint} numberOfLines={1}>
                {API_BASE_URL}
              </Text>
            </View>
          </View>
        </Section>

        <Section title={t("Dev tools")}>
          <Pressable
            onPress={onRegisterDevice}
            disabled={busy !== null}
            style={[styles.toolBtn, busy && styles.toolBtnBusy]}
          >
            {busy === "register" ? (
              <ActivityIndicator color={colors.ink} />
            ) : (
              <Text style={styles.toolBtnText}>{t("Register push device")}</Text>
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
              <Text style={styles.toolBtnText}>{t("Send test push")}</Text>
            )}
          </Pressable>
          <Text style={styles.rowHint}>{t("Removed before launch.")}</Text>
        </Section>

        <Pressable
          onPress={onSignOut}
          disabled={busy !== null}
          style={[styles.signOut, busy && styles.toolBtnBusy]}
        >
          {busy === "signout" ? (
            <ActivityIndicator color={colors.overdue} />
          ) : (
            <Text style={styles.signOutText}>{t("Sign out")}</Text>
          )}
        </Pressable>

        {/* Apple requires in-app account deletion for any app that offers
            account creation. Kept visually quieter than Sign out — it is
            not an action anyone should reach for by accident. */}
        <Pressable
          onPress={() => router.push("/delete-account" as Href)}
          style={styles.deleteAccountBtn}
        >
          <Text style={styles.deleteAccountText}>{t("Delete account")}</Text>
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
  headerCancel: { color: colors.accent, fontSize: 14, fontWeight: "600", minWidth: 64 },
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
  densityBlock: { paddingVertical: 12, gap: 10 },
  densityRow: { flexDirection: "row", gap: 8 },
  densityPip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.canvas,
    alignItems: "center",
  },
  densityPipActive: { borderColor: colors.accent, backgroundColor: colors.accent },
  densityPipText: { color: colors.inkDim, fontSize: 14, fontWeight: "600" },
  densityPipTextActive: { color: colors.canvas },
  quietRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
  },
  quietValue: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  quietDoneRow: { alignItems: "flex-end", paddingVertical: 8 },
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
  deleteAccountBtn: { alignItems: "center", paddingVertical: 16 },
  deleteAccountText: { color: colors.inkDim, fontSize: 13, fontWeight: "600" },
});
