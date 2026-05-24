// Intelligent search — full-screen modal that takes a text or voice
// query, posts it to /tasks/search, and stores the matching task IDs
// in the universe store. On dismiss the canvas enters "search-result
// mode": matching bubbles brighten, others dim to ~20%, and a pill
// at the top of the canvas shows the query + a clear button.
//
// Triggered from the search icon top-right of the universe header.

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

import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { ApiError, searchTasks, transcribeAudio } from "@/services/api";
import { useUniverseStore } from "@/stores/universeStore";
import { colors } from "@/theme/colors";

// Min hold duration before we treat a mic press as a real query — same
// guard as the task-detail dictation mic.
const MIN_RECORDING_MS = 500;

export default function SearchScreen() {
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
    const startedAt = voiceStartedAt.current;
    voiceStartedAt.current = null;
    const result = await voice.stop();
    if (!result) return;
    const duration = startedAt ? Date.now() - startedAt : 0;
    if (duration < MIN_RECORDING_MS) {
      setError("Hold the mic for at least half a second.");
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
        <View style={styles.header}>
          <Pressable
            onPress={() => router.back()}
            hitSlop={12}
            style={styles.headerSide}
            accessibilityLabel="Close"
          >
            <View style={styles.headerCloseGroup}>
              <MaterialIcons name="chevron-left" size={22} color={colors.inkDim} />
              <Text style={styles.headerCloseText}>Close</Text>
            </View>
          </Pressable>
          <Text style={styles.headerTitle}>Search</Text>
          <View style={styles.headerSide} />
        </View>

        <View style={styles.body}>
          <Text style={styles.label}>What are you looking for?</Text>
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
            Orbi looks across every task you have, regardless of cluster.
            Hold the mic to dictate.
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
                <ActivityIndicator color={colors.ink} />
              ) : (
                <Text style={styles.micText}>🎙</Text>
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
                <ActivityIndicator color="white" />
              ) : (
                <>
                  <MaterialIcons name="search" size={18} color="white" />
                  <Text style={styles.searchBtnText}>Search</Text>
                </>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  flex: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  headerSide: { minWidth: 72 },
  headerTitle: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  headerCloseGroup: { flexDirection: "row", alignItems: "center", marginLeft: -6 },
  headerCloseText: { color: colors.inkDim, fontSize: 14 },
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
  micCircle: {
    width: 50,
    height: 50,
    borderRadius: 25,
    borderColor: colors.line,
    borderWidth: 1.5,
    backgroundColor: colors.panel,
    alignItems: "center",
    justifyContent: "center",
  },
  micCircleActive: {
    borderColor: colors.overdue,
    backgroundColor: "rgba(255, 77, 109, 0.15)",
  },
  micBusy: { opacity: 0.6 },
  micText: { fontSize: 22 },
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
  searchBtnText: { color: "white", fontSize: 15, fontWeight: "700" },
});
