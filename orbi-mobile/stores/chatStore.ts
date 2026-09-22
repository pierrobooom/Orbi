// Conversation state for the Chat tab.
//
// One rolling session per device. The session id is persisted, because
// without it every message started a NEW session server-side — the
// events were stored but scattered across dozens of one-message
// conversations, so the coordinator's "recent conversation" context was
// always empty and reopening the app looked like talking to an
// assistant with no memory.
//
// Messages are optimistic: the user's line appears instantly and the
// reply lands when the server answers. A failed send marks that message
// rather than dropping it, so nothing the user typed disappears.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";

import {
  ApiError,
  chatMessage,
  getChatHistory,
  type ChatResponse,
} from "@/services/api";

const SESSION_KEY = "orbi.chat.sessionId";

// When the user last tapped "New". Anything the server holds from before
// that moment is not shown again.
//
// Clearing used to drop the session id and empty the list, which looked
// right until the next hydrate: with no id, the server is asked for the most
// recent session, and it handed back the conversation that had just been
// dismissed. Worse, voice commands are recorded into that same history, so a
// cleared chat would refill itself with things the user had spoken elsewhere
// and never typed here.
//
// A timestamp rather than a flag, because it answers the harder question
// correctly: a voice command made AFTER the clear is a new exchange and
// belongs on screen, while the same command from before it does not.
const CLEARED_AT_KEY = "orbi.chat.clearedAt";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** How this turn arrived. Voice commands and replies sent from a
   * notification are recorded in the same conversation as typed messages,
   * so without this the user sees their own dictation in the log and
   * reasonably concludes the app is writing messages as them. */
  source?: string | null;
  // Set on a user message whose send failed, so the UI can mark it and
  // offer a retry instead of silently losing what was typed.
  failed?: boolean;
  pending?: boolean;
  // Structured payload from the coordinator (parsed tasks, or an action
  // proposal). The screen uses it to offer a follow-up, never to act.
  data?: unknown;
}

type Status = "idle" | "loading" | "ready" | "error";

interface ChatState {
  status: Status;
  sessionId: string | null;
  messages: ChatMessage[];
  sending: boolean;
  errorMessage: string | null;
  hydrate: () => Promise<void>;
  send: (text: string, source?: "text" | "voice") => Promise<ChatResponse | null>;
  clear: () => Promise<void>;
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const useChatStore = create<ChatState>((set, get) => ({
  status: "idle",
  sessionId: null,
  messages: [],
  sending: false,
  errorMessage: null,

  hydrate: async () => {
    if (get().status === "idle") set({ status: "loading" });
    let stored: string | null = null;
    let clearedAt = 0;
    try {
      stored = await AsyncStorage.getItem(SESSION_KEY);
      clearedAt = Number((await AsyncStorage.getItem(CLEARED_AT_KEY)) ?? 0);
    } catch {
      // A missing store is not fatal — we just start a new session.
      stored = null;
    }
    try {
      const history = await getChatHistory(stored ?? undefined);
      const sessionId = history.session_id ?? stored ?? null;
      if (sessionId && sessionId !== stored) {
        // Adopt whatever the server considers current, so the app and
        // the backend agree on which conversation this is.
        try {
          await AsyncStorage.setItem(SESSION_KEY, sessionId);
        } catch {
          /* non-fatal */
        }
      }
      // Everything from before the last "New" stays in the database and
      // stays off the screen.
      const visible = history.messages.filter(
        (m) => !clearedAt || Date.parse(m.created_at) > clearedAt,
      );

      set({
        status: "ready",
        // Only adopt the server's session when something in it is still
        // visible. Adopting an entirely dismissed one would append the next
        // message to the conversation the user just walked away from.
        sessionId: visible.length > 0 ? sessionId : null,
        errorMessage: null,
        messages: visible.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          source: m.source,
        })),
      });
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      // Keep whatever is already on screen; an unreachable history
      // endpoint shouldn't blank a conversation the user can still see.
      set({ status: "error", errorMessage: msg });
    }
  },

  send: async (text, source = "text") => {
    const trimmed = text.trim();
    if (!trimmed || get().sending) return null;

    const localId = makeId();
    set((s) => ({
      sending: true,
      errorMessage: null,
      messages: [
        ...s.messages,
        { id: localId, role: "user", content: trimmed, pending: true },
      ],
    }));

    try {
      // Chat always opts into retrieval — this surface is where the
      // user asks questions, not just issues commands.
      const reply = await chatMessage(
        trimmed,
        source,
        get().sessionId ?? undefined,
        true,
      );

      // First message of a fresh conversation: the server minted the
      // session id, so adopt and persist it.
      if (reply.session_id && reply.session_id !== get().sessionId) {
        set({ sessionId: reply.session_id });
        try {
          await AsyncStorage.setItem(SESSION_KEY, reply.session_id);
        } catch {
          /* non-fatal */
        }
      }

      set((s) => ({
        sending: false,
        messages: [
          ...s.messages.map((m) =>
            m.id === localId ? { ...m, pending: false } : m,
          ),
          {
            id: makeId(),
            role: "assistant" as const,
            content: reply.reply,
            data: reply.data,
          },
        ],
      }));
      return reply;
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      set((s) => ({
        sending: false,
        errorMessage: msg,
        messages: s.messages.map((m) =>
          m.id === localId ? { ...m, pending: false, failed: true } : m,
        ),
      }));
      return null;
    }
  },

  clear: async () => {
    // Starts a new server-side session on the next send by forgetting
    // the current id. Past messages stay in the database — this is "new
    // conversation", not "delete history".
    try {
      await AsyncStorage.removeItem(SESSION_KEY);
      // Recorded before the state change so a hydrate racing this cannot
      // read the old value and refill the list.
      await AsyncStorage.setItem(CLEARED_AT_KEY, String(Date.now()));
    } catch {
      /* non-fatal */
    }
    set({ sessionId: null, messages: [], errorMessage: null, status: "ready" });
  },
}));
