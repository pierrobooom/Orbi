// Chat tab — free-form conversation with Orbi.
//
// The backend has had /chat and /memory since Phase 2; nothing in the app
// reached them except the voice-capture path, which used /chat purely as
// a parser and threw the reply away. This surface is where the assistant
// half of "conversational life OS" actually becomes usable.
//
// Same pipeline as the universe mic, so anything you can say there works
// here typed: capture a task, complete one, ask what's overdue. The
// difference is that a structured result becomes an offer — a card you
// tap to confirm — rather than an immediate navigation, because in a
// chat you are often thinking out loud rather than issuing a command.
//
// That principle applies to list results too. An earlier version pushed
// matches into the Universe tab's focused-cluster view, which meant
// asking "show me the gym tasks" silently rearranged a screen you were
// not looking at and then made you go find it. A question asked in the
// chat gets answered in the chat: the matches render as rows you can tap
// straight through to.

import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { SafeAreaView } from "react-native-safe-area-context";

import { useT } from "@/i18n";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { ApiError, isQuotaError, transcribeAudio } from "@/services/api";
import { useChatStore, type ChatMessage } from "@/stores/chatStore";
import { colors } from "@/theme/colors";

interface ParsedTask {
  title?: string;
  label?: string | null;
  description?: string | null;
  due_at?: string | null;
  parent_cluster_id?: string | null;
  importance?: number;
  confidence?: number;
}

interface ListResult {
  id: string;
  title: string;
  label?: string | null;
  due_at?: string | null;
  parent_cluster_id?: string | null;
}

interface ChatData {
  tasks?: ParsedTask[];
  results?: ListResult[];
  count?: number;
  action?: "complete" | "delete" | "update" | "list";
  resolved?: boolean;
  ambiguous?: boolean;
  task?: { id: string; title: string };
  alternatives?: { id: string; title: string }[];
  patch?: Record<string, unknown>;
  task_ids?: string[];
}

export default function ChatScreen() {
  const t = useT();
  const router = useRouter();
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const status = useChatStore((s) => s.status);
  const messages = useChatStore((s) => s.messages);
  const sending = useChatStore((s) => s.sending);
  const hydrate = useChatStore((s) => s.hydrate);
  const send = useChatStore((s) => s.send);
  const clear = useChatStore((s) => s.clear);

  const [draft, setDraft] = useState("");
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const voice = useVoiceRecorder();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // Keep the newest message visible as the conversation grows.
  useEffect(() => {
    if (messages.length === 0) return;
    const id = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60);
    return () => clearTimeout(id);
  }, [messages.length]);

  const submit = useCallback(
    async (text: string, source: "text" | "voice") => {
      setError(null);
      await send(text, source);
      // Deliberately does NOT touch the universe. List results render
      // inline below the reply — see the note at the top of the file.
    },
    [send],
  );

  const onSend = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    Keyboard.dismiss();
    await submit(text, "text");
  };

  const onMicPressIn = async () => {
    setError(null);
    const ok = await voice.start();
    if (!ok) setError(voice.permissionError ?? t("Could not start recording."));
  };

  const onMicPressOut = async () => {
    const result = await voice.stop();
    if (!result) {
      if (voice.tooShort) setError(t("Keep the mic pressed to record."));
      return;
    }
    setVoiceBusy(true);
    try {
      const { transcript } = await transcribeAudio(result.uri, result.mimeType);
      if (!transcript || transcript.trim().length === 0) {
        setError(t("Couldn't hear that. Try again."));
        return;
      }
      await submit(transcript, "voice");
    } catch (e) {
      if (isQuotaError(e)) {
        setError(e.message);
      } else {
        setError(e instanceof ApiError ? e.message : String(e));
      }
    } finally {
      setVoiceBusy(false);
    }
  };

  const openTaskOffer = (data: ChatData) => {
    if (data.tasks && data.tasks.length > 0) {
      router.push({
        pathname: "/voice-confirm",
        params: {
          payload: JSON.stringify({ tasks: data.tasks, transcript: t("From chat") }),
        },
      });
      return;
    }
    if (data.action && data.action !== "list" && data.resolved && data.task) {
      router.push({
        pathname: "/voice-action",
        params: {
          payload: JSON.stringify({
            action: data.action,
            transcript: t("From chat"),
            task: data.task,
            ambiguous: data.ambiguous ?? false,
            alternatives: data.alternatives ?? [],
            patch: data.patch ?? {},
          }),
        },
      });
    }
  };

  const renderItem = ({ item }: { item: ChatMessage }) => {
    const mine = item.role === "user";
    const data = item.data as ChatData | null;
    const offersTasks = !!data?.tasks && data.tasks.length > 0;
    const offersAction =
      !!data?.action && data.action !== "list" && !!data.resolved && !!data.task;
    const results = data?.action === "list" ? (data.results ?? []) : [];
    const total = data?.count ?? results.length;

    return (
      <View style={[styles.row, mine ? styles.rowMine : styles.rowTheirs]}>
        <View
          style={[
            styles.bubble,
            mine ? styles.bubbleMine : styles.bubbleTheirs,
            item.failed && styles.bubbleFailed,
            item.pending && styles.bubblePending,
          ]}
        >
          <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>
            {item.content}
          </Text>
          {item.failed ? (
            <Text style={styles.failedNote}>{t("Not sent")}</Text>
          ) : null}
        </View>

        {results.length > 0 ? (
          <View style={styles.results}>
            {results.map((r) => (
              <Pressable
                key={r.id}
                style={styles.resultRow}
                onPress={() =>
                  router.push({ pathname: "/task-detail", params: { id: r.id } })
                }
              >
                <View style={styles.resultDot} />
                <View style={styles.resultBody}>
                  <Text style={styles.resultTitle} numberOfLines={2}>
                    {r.title}
                  </Text>
                  {r.due_at ? (
                    <Text
                      style={[
                        styles.resultDue,
                        new Date(r.due_at) < new Date() && styles.resultOverdue,
                      ]}
                    >
                      {new Date(r.due_at).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </Text>
                  ) : null}
                </View>
                <MaterialIcons
                  name="chevron-right"
                  size={18}
                  color={colors.inkDim}
                />
              </Pressable>
            ))}
            {total > results.length ? (
              <Text style={styles.resultMore}>
                {t("Showing {n} of {total}", { n: results.length, total })}
              </Text>
            ) : null}
          </View>
        ) : null}

        {offersTasks || offersAction ? (
          <Pressable style={styles.offer} onPress={() => openTaskOffer(data!)}>
            <MaterialIcons
              name={offersTasks ? "add-circle-outline" : "task-alt"}
              size={15}
              color={colors.accent}
            />
            <Text style={styles.offerText}>
              {offersTasks
                ? data!.tasks!.length > 1
                  ? t("Review {n} tasks", { n: data!.tasks!.length })
                  : t("Review task")
                : t("Review change")}
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t("Chat")}</Text>
        <Pressable onPress={() => clear()} hitSlop={10}>
          <Text style={styles.headerAction} numberOfLines={1}>
            {t("New")}
          </Text>
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 88 : 0}
      >
        {status === "loading" && messages.length === 0 ? (
          <View style={styles.centered}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : messages.length === 0 ? (
          <View style={styles.centered}>
            <Text style={styles.emptyTitle}>{t("Ask Orbi anything")}</Text>
            <Text style={styles.emptyBody}>
              {t(
                "Capture a task, ask what's overdue, or mark something done — typed or spoken.",
              )}
            </Text>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => m.id}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            onContentSizeChange={() =>
              listRef.current?.scrollToEnd({ animated: false })
            }
          />
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.composer}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={t("Message Orbi")}
            placeholderTextColor={colors.inkDim}
            style={styles.input}
            multiline
            maxLength={800}
          />
          {draft.trim().length > 0 ? (
            <Pressable
              onPress={onSend}
              disabled={sending}
              style={[styles.sendBtn, sending && styles.btnDisabled]}
            >
              {sending ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <MaterialIcons name="arrow-upward" size={20} color="white" />
              )}
            </Pressable>
          ) : (
            <Pressable
              onPressIn={onMicPressIn}
              onPressOut={onMicPressOut}
              disabled={voiceBusy || sending}
              style={[
                styles.micBtn,
                voice.isRecording && styles.micBtnActive,
                (voiceBusy || sending) && styles.btnDisabled,
              ]}
            >
              {voiceBusy ? (
                <ActivityIndicator size="small" color={colors.accent} />
              ) : (
                <MaterialIcons
                  name="mic"
                  size={20}
                  color={voice.isRecording ? "white" : colors.inkDim}
                />
              )}
            </Pressable>
          )}
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
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 22,
    paddingTop: 10,
    paddingBottom: 12,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  headerTitle: { color: colors.ink, fontSize: 22, fontWeight: "700" },
  headerAction: { color: colors.accent, fontSize: 14, fontWeight: "600", minWidth: 40 },
  centered: { flex: 1, justifyContent: "center", alignItems: "center", padding: 32 },
  emptyTitle: { color: colors.ink, fontSize: 17, fontWeight: "600", marginBottom: 8 },
  emptyBody: {
    color: colors.inkDim,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
  },
  listContent: { padding: 16, paddingBottom: 24 },
  row: { marginBottom: 12 },
  rowMine: { alignItems: "flex-end" },
  rowTheirs: { alignItems: "flex-start" },
  bubble: {
    maxWidth: "86%",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bubbleMine: { backgroundColor: colors.accent, borderBottomRightRadius: 4 },
  bubbleTheirs: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderBottomLeftRadius: 4,
  },
  bubblePending: { opacity: 0.6 },
  bubbleFailed: { borderColor: colors.overdue, borderWidth: 1 },
  bubbleText: { color: colors.ink, fontSize: 15, lineHeight: 21 },
  bubbleTextMine: { color: "white" },
  failedNote: { color: colors.overdue, fontSize: 11, marginTop: 4, fontWeight: "600" },
  offer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  offerText: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  results: {
    marginTop: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: "hidden",
    alignSelf: "stretch",
  },
  resultRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  resultDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.accent,
  },
  resultBody: { flex: 1 },
  resultTitle: { color: colors.ink, fontSize: 14, lineHeight: 19 },
  resultDue: { color: colors.inkDim, fontSize: 11, marginTop: 2 },
  resultOverdue: { color: colors.overdue, fontWeight: "700" },
  resultMore: {
    color: colors.inkDim,
    fontSize: 11,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  error: {
    color: colors.overdue,
    fontSize: 12,
    paddingHorizontal: 18,
    paddingBottom: 6,
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 14,
    borderTopColor: colors.line,
    borderTopWidth: 1,
  },
  input: {
    flex: 1,
    color: colors.ink,
    fontSize: 15,
    maxHeight: 120,
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  micBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
  },
  micBtnActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  btnDisabled: { opacity: 0.5 },
});
