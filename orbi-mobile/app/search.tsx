// Intelligent search — full-screen modal that takes a text or voice
// query, posts it to /tasks/search, and stores the matching task IDs
// in the universe store. On dismiss the canvas enters "search-result
// mode": matching bubbles brighten, others dim to ~20%, and a pill
// at the top of the canvas shows the query + a clear button.
//
// Triggered from the search icon top-right of the universe header.

import Feather from "@expo/vector-icons/Feather";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useRouter } from "expo-router";
import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/screen-header";
import { useT } from "@/i18n";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { ApiError, searchTasks, transcribeAudio } from "@/services/api";
import { useUniverseStore } from "@/stores/universeStore";
import { colors } from "@/theme/colors";
import { themed } from "@/theme/themed";

export default function SearchScreen() {
  const t = useT();
  const router = useRouter();
  const setSearchResults = useUniverseStore((s) => s.setSearchResults);

  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<"search" | "voice" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const voice = useVoiceRecorder();
  const voiceStartedAt = useRef<number | null>(null);

  const doSearch = async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setBusy("search");
    setError(null);
    try {
      const res = await searchTasks(trimmed);
      if (!res.embedded) {
        setError("Search is temporarily unavailable. Try again in a moment.");
        return;
      }
      setSearchResults(trimmed, res.hits.map((h) => h.id));
      router.back();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onMicPressIn = async () => {
    setError(null);
    voiceStartedAt.current = Date.now();
    const ok = await voice.start();
    if (!ok) {
      voiceStartedAt.current = null;
      setError(voice.permissionError ?? "Could not start recording.");
    }
  };

  const onMicPressOut = async () => {
    voiceStartedAt.current = null;
    const result = await voice.stop();
    if (!result) {
      if (voice.tooShort) setError(t("Keep the mic pressed to record."));
      return;
    }
    setBusy("voice");
    try {
      const { transcript } = await transcribeAudio(result.uri, result.mimeType);
      const trimmed = (transcript ?? "").trim();
      if (!trimmed) {
        setError("Couldn't hear that. Try again.");
        return;
      }
      setQuery(trimmed);
      await doSearch(trimmed);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      setError(msg);
    } finally {
      setBusy(null);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        <ScreenHeader title={t("Search")} />

        <View style={styles.body}>
          <Text style={styles.label}>{t("What are you looking for?")}</Text>
          <TextInput
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={() => doSearch(query)}
            placeholder='e.g. "gym and exercise" or "bills due this week"'
            placeholderTextColor={colors.inkDim}
            style={styles.input}
            autoFocus
            autoCapitalize="none"
            autoCorrect
            returnKeyType="search"
            editable={busy === null}
          />

          <Text style={styles.hint}>
            {t(
              "Orbi looks across every task you have, regardless of cluster. Hold the mic to dictate.",
            )}
          </Text>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <View style={styles.actions}>
            <Pressable
              onPressIn={onMicPressIn}
              onPressOut={onMicPressOut}
              disabled={busy !== null}
              hitSlop={8}
              style={[
                styles.micCircle,
                voice.isRecording && styles.micCircleActive,
                busy === "voice" && styles.micBusy,
              ]}
              accessibilityLabel="Hold to dictate search"
            >
              {busy === "voice" ? (
                <ActivityIndicator color={colors.canvas} />
              ) : (
                <Feather name="mic" size={24} color={colors.canvas} />
              )}
            </Pressable>
            <Pressable
              onPress={() => doSearch(query)}
              disabled={busy !== null || !query.trim()}
              style={[
                styles.searchBtn,
                (busy !== null || !query.trim()) && styles.searchBtnDisabled,
              ]}
            >
              {busy === "search" ? (
                <ActivityIndicator color={colors.canvas} />
              ) : (
                <>
                  <MaterialIcons name="search" size={18} color={colors.canvas} />
                  <Text style={styles.searchBtnText}>{t("Search")}</Text>
                </>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = themed(() => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  flex: { flex: 1 },
  body: { padding: 20 },
  label: { color: colors.inkDim, fontSize: 11, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase" },
  input: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    marginTop: 10,
    color: colors.ink,
    fontSize: 15,
  },
  hint: {
    color: colors.inkDim,
    fontSize: 12,
    marginTop: 14,
    lineHeight: 17,
  },
  error: { color: colors.overdue, fontSize: 13, marginTop: 14 },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    marginTop: 24,
  },
  // The same mic as the universe: an ink circle and a stroke glyph, red while
  // recording. It was the 🎙 emoji here — drawn by the system font, unable
  // to take a colour, and a different shape on every OS version.
  micCircle: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  micCircleActive: {
    backgroundColor: colors.overdue,
  },
  micBusy: { opacity: 0.6 },
  searchBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 50,
    borderRadius: 12,
    backgroundColor: colors.accent,
  },
  searchBtnDisabled: { opacity: 0.5 },
  searchBtnText: { color: colors.canvas, fontSize: 15, fontWeight: "700" },
}));
