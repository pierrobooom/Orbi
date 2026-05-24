// Backend API client.
//
// Three ways the FastAPI base URL gets resolved, in order of priority:
//   1. EXPO_PUBLIC_API_BASE_URL env var — explicit override. Use this when
//      the phone and laptop are on different networks and the backend is
//      exposed via a public tunnel (ngrok, Cloudflare Tunnel, etc).
//   2. Auto-derive from Expo's dev-server hostname, rewriting port 8081
//      to 8000. Works when phone + laptop are on the same LAN.
//   3. localhost fallback for web preview.
// Production will replace all three with a fixed cloud URL.

import Constants from "expo-constants";

import { supabase } from "@/services/supabase";

function resolveBaseUrl(): string {
  const override = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (override && override.length > 0) return override;

  const hostUri =
    Constants.expoConfig?.hostUri ??
    (Constants as unknown as { manifest2?: { extra?: { expoGo?: { developer?: { tool?: string } } } } })
      .manifest2?.extra?.expoGo?.developer?.tool;
  if (hostUri && typeof hostUri === "string") {
    const host = hostUri.split(":")[0];
    return `http://${host}:8000`;
  }
  return "http://localhost:8000";
}

export const API_BASE_URL = resolveBaseUrl();

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  status: number;
  errorCode: string | null;

  constructor(status: number, message: string, errorCode: string | null) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
  }
}

async function parseError(res: Response): Promise<ApiError> {
  // Backend returns { detail: { message, error_code } } on structured errors.
  try {
    const body = (await res.json()) as { detail?: { message?: string; error_code?: string } };
    const message = body?.detail?.message ?? `HTTP ${res.status}`;
    const code = body?.detail?.error_code ?? null;
    return new ApiError(res.status, message, code);
  } catch {
    return new ApiError(res.status, `HTTP ${res.status}`, null);
  }
}

// ---------------------------------------------------------------------------
// authFetch — attach Bearer, retry once on 401
// ---------------------------------------------------------------------------

interface AuthFetchOptions extends RequestInit {
  // Skip auth entirely (e.g. /health). Default: false.
  unauthed?: boolean;
}

async function authFetch(path: string, options: AuthFetchOptions = {}): Promise<Response> {
  const { unauthed, headers, ...rest } = options;
  const url = `${API_BASE_URL}${path}`;

  const buildHeaders = async (): Promise<HeadersInit> => {
    const base: Record<string, string> = {
      "Content-Type": "application/json",
      ...((headers as Record<string, string>) ?? {}),
    };
    if (unauthed) return base;

    // Always pull the live session — supabase-js may have rotated the access
    // token in the background since the last call.
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) base.Authorization = `Bearer ${token}`;
    return base;
  };

  let res = await fetch(url, { ...rest, headers: await buildHeaders() });

  if (res.status === 401 && !unauthed) {
    // Token may have expired between the read above and the request landing.
    // Force one refresh and retry. If still 401, the caller handles it
    // (typically by signing the user out).
    const refreshed = await supabase.auth.refreshSession();
    if (refreshed.data.session) {
      res = await fetch(url, { ...rest, headers: await buildHeaders() });
    }
  }

  return res;
}

// ---------------------------------------------------------------------------
// Typed endpoints
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: string;
  app: string;
}

export async function getHealth(): Promise<HealthResponse> {
  const res = await authFetch("/health", { unauthed: true });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as HealthResponse;
}

export interface UserProfile {
  id: string;
  email: string;
  full_name: string;
  subscription_tier: "free" | "pro" | "premium";
  created_at: string;
  updated_at: string;
}

// Routers are mounted under /api/v1 in orbi-backend/main.py. The /health
// endpoint is the only unprefixed route.
const V1 = "/api/v1";

export async function getMyProfile(): Promise<UserProfile> {
  const res = await authFetch(`${V1}/users/me`);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as UserProfile;
}

export async function patchMyProfile(fields: { full_name: string }): Promise<UserProfile> {
  const res = await authFetch(`${V1}/users/me`, {
    method: "PATCH",
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as UserProfile;
}

// ---------------------------------------------------------------------------
// Usage / quota snapshot
// ---------------------------------------------------------------------------

export interface UsageMeter {
  used: number;
  cap: number;
}

export interface UsageSnapshot {
  tier: "free" | "pro" | "premium";
  daily: Record<string, UsageMeter>;
  monthly: Record<string, UsageMeter>;
  resets: { daily: string; monthly: string };
}

export async function getMyUsage(): Promise<UsageSnapshot> {
  const res = await authFetch(`${V1}/users/me/usage`);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as UsageSnapshot;
}

// Backend error codes that signal a quota breach. Used by the UI to swap
// the generic red toast for an upgrade-prompting one.
const QUOTA_ERROR_CODES = new Set([
  "STT_QUOTA_EXCEEDED",
  "TTS_QUOTA_EXCEEDED",
  "AI_TURN_QUOTA_EXCEEDED",
  "CLAUDE_CALL_QUOTA_EXCEEDED",
]);

export function isQuotaError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.errorCode !== null && QUOTA_ERROR_CODES.has(err.errorCode);
}

// ---------------------------------------------------------------------------
// Push notification device tokens
// ---------------------------------------------------------------------------

export type DevicePlatform = "ios" | "android" | "web";

export interface DeviceToken {
  id: string;
  user_id: string;
  token: string;
  platform: DevicePlatform;
  created_at: string;
  last_seen_at: string;
}

export async function registerPushToken(
  token: string,
  platform: DevicePlatform,
): Promise<DeviceToken> {
  const res = await authFetch(`${V1}/users/me/device-tokens`, {
    method: "POST",
    body: JSON.stringify({ token, platform }),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as DeviceToken;
}

export async function unregisterPushToken(token: string): Promise<void> {
  // The token contains brackets ("ExponentPushToken[...]") so it has to be
  // URI-encoded before going into the path.
  const res = await authFetch(
    `${V1}/users/me/device-tokens/${encodeURIComponent(token)}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404) throw await parseError(res);
}

export interface TestPushResponse {
  sent: number;
  tickets: Array<{ status: string; id?: string; message?: string }>;
}

export async function sendTestPush(): Promise<TestPushResponse> {
  const res = await authFetch(`${V1}/users/me/device-tokens/test`, {
    method: "POST",
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as TestPushResponse;
}

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

export type EntryType = "income" | "expense";

export interface ServerFinanceEntry {
  id: string;
  user_id: string;
  amount: number;
  currency: string;
  merchant: string;
  category: string;
  entry_type: EntryType;
  entry_date: string; // ISO date YYYY-MM-DD
  source_type: string;
  linked_bubble_id: string | null;
  notes: string | null;
  created_at: string;
}

export async function listFinanceEntries(month?: string): Promise<ServerFinanceEntry[]> {
  const qs = month ? `?month=${encodeURIComponent(month)}` : "";
  const res = await authFetch(`${V1}/finance/entries${qs}`);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ServerFinanceEntry[];
}

export interface CreateFinanceEntryInput {
  amount: number;
  merchant: string;
  entry_date: string; // YYYY-MM-DD
  entry_type?: EntryType;
  currency?: string;
  category?: string; // optional override; backend categorises if absent
  notes?: string | null;
}

export async function createFinanceEntry(
  input: CreateFinanceEntryInput,
): Promise<ServerFinanceEntry> {
  // owner is forced server-side from JWT but the Pydantic model marks
  // user_id required — pull from session to satisfy validation.
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user.id;
  if (!userId) {
    throw new ApiError(401, "Not authenticated.", "NOT_AUTHENTICATED");
  }
  const body = {
    user_id: userId,
    amount: input.amount,
    currency: input.currency ?? "GBP",
    merchant: input.merchant,
    // Backend re-categorises via the rule table; sending "uncategorized"
    // makes the intent explicit when the caller doesn't want to override.
    category: input.category ?? "uncategorized",
    entry_type: input.entry_type ?? "expense",
    entry_date: input.entry_date,
    source_type: "manual",
    notes: input.notes ?? null,
  };
  const res = await authFetch(`${V1}/finance/entries`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ServerFinanceEntry;
}

export interface FinanceSummary {
  month: string;
  totals: Record<string, number>;
  total_spend: number;
  total_income: number;
}

export async function getFinanceSummary(month?: string): Promise<FinanceSummary> {
  const qs = month ? `?month=${encodeURIComponent(month)}` : "";
  const res = await authFetch(`${V1}/finance/summary${qs}`);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as FinanceSummary;
}

export interface UpdateFinanceEntryInput {
  amount?: number;
  merchant?: string;
  category?: string;
  entry_date?: string; // YYYY-MM-DD
  entry_type?: EntryType;
  notes?: string | null;
}

export async function updateFinanceEntry(
  id: string,
  patch: UpdateFinanceEntryInput,
): Promise<ServerFinanceEntry> {
  const res = await authFetch(`${V1}/finance/entries/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ServerFinanceEntry;
}

export async function deleteFinanceEntry(id: string): Promise<void> {
  const res = await authFetch(`${V1}/finance/entries/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw await parseError(res);
}

// ---------------------------------------------------------------------------
// Tasks + Clusters
// ---------------------------------------------------------------------------
//
// Names prefixed with `Server` to distinguish the wire shapes from the
// canvas-side Cluster / Bubble types in components/universe/types.ts. The
// canvas types include layout fields (kind, centerX/Y, isDominant, offsets)
// that don't exist server-side — services/universeLayout.ts derives them.

export type ServerTaskStatus = "active" | "completed" | "snoozed" | "archived";
export type ServerVisibility = "private" | "shared" | "collaborative";

export interface ServerTask {
  id: string;
  owner_id: string;
  title: string;
  // Short keyword rendered inside the bubble. Server auto-derives
  // when client omits it; null on pre-0005-migration rows.
  label: string | null;
  description: string | null;
  status: ServerTaskStatus;
  due_at: string | null;
  importance: number;
  urgency_score: number;
  pressure_score: number;
  domain_hint: string | null;
  parent_cluster_id: string | null;
  source_type: string;
  confidence: number;
  visibility: ServerVisibility;
  created_at: string;
  updated_at: string;
}

export interface ServerCluster {
  id: string;
  owner_id: string;
  name: string;
  summary: string | null;
  color: string;
  weight_score: number;
  active_count: number;
  parent_cluster_id: string | null;
  created_at: string;
}

export async function listTasks(): Promise<ServerTask[]> {
  const res = await authFetch(`${V1}/tasks`);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ServerTask[];
}

export async function listClusters(): Promise<ServerCluster[]> {
  const res = await authFetch(`${V1}/clusters`);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ServerCluster[];
}

export interface CreateClusterInput {
  name: string;
  color: string;
  summary?: string | null;
}

export async function createCluster(input: CreateClusterInput): Promise<ServerCluster> {
  const res = await authFetch(`${V1}/clusters`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ServerCluster;
}

export interface UpdateClusterInput {
  name?: string;
  color?: string;
  summary?: string | null;
}

export async function updateCluster(
  id: string,
  patch: UpdateClusterInput,
): Promise<ServerCluster> {
  const res = await authFetch(`${V1}/clusters/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ServerCluster;
}

export async function deleteCluster(id: string): Promise<void> {
  const res = await authFetch(`${V1}/clusters/${id}`, { method: "DELETE" });
  if (!res.ok) throw await parseError(res);
}

// ---------------------------------------------------------------------------
// Auto-organisation — LLM-proposed cluster reshuffles the user reviews
// ---------------------------------------------------------------------------

// One reorganisation action. Mirrors the server's ProposalAction shape.
// `type` is the discriminator; only a subset of the other fields is set
// for each variant, and we keep the carrier loose so the server stays
// the source of truth on what's valid.
export interface ProposalAction {
  type: "create_cluster" | "move_tasks" | "merge_clusters" | "rename_cluster";
  // create_cluster
  name?: string;
  color?: string;
  // rename_cluster
  new_name?: string;
  // rename_cluster / move_tasks
  cluster_id?: string;
  // merge_clusters
  source_id?: string;
  target_id?: string;
  // create_cluster / move_tasks
  task_ids?: string[];
  // Human-readable reason shown in the review modal.
  reason?: string;
}

export interface ProposalResponse {
  actions: ProposalAction[];
}

export interface ApplyResponse {
  applied: Record<string, number>;
  skipped: { type: string; action: ProposalAction }[];
}

export async function proposeOrganisation(): Promise<ProposalResponse> {
  const res = await authFetch(`${V1}/clusters/auto-organize`, { method: "POST" });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ProposalResponse;
}

export async function applyOrganisation(
  actions: ProposalAction[],
): Promise<ApplyResponse> {
  const res = await authFetch(`${V1}/clusters/apply-organisation`, {
    method: "POST",
    body: JSON.stringify({ actions }),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ApplyResponse;
}

// ---------------------------------------------------------------------------
// Semantic task search — embed the query server-side, cosine-match
// against the user's task embeddings
// ---------------------------------------------------------------------------

export interface TaskSearchHit {
  id: string;
  title: string;
  label: string | null;
  similarity: number;
  parent_cluster_id: string | null;
}

export interface TaskSearchResponse {
  query: string;
  // false when the embedding service was unavailable — mobile shows a
  // "search unavailable" message rather than "no matches found".
  embedded: boolean;
  hits: TaskSearchHit[];
}

export async function searchTasks(query: string): Promise<TaskSearchResponse> {
  const res = await authFetch(`${V1}/tasks/search`, {
    method: "POST",
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as TaskSearchResponse;
}

export interface CreateTaskInput {
  title: string;
  label?: string | null;
  description?: string | null;
  parent_cluster_id?: string | null;
  due_at?: string | null;
  importance?: number;
}

// ---------------------------------------------------------------------------
// Voice + Chat
// ---------------------------------------------------------------------------

export interface TranscriptionResult {
  transcript: string;
  confidence: number;
  duration_seconds: number;
  provider: string;
  model: string;
}

export async function transcribeAudio(
  uri: string,
  mimeType: string,
): Promise<TranscriptionResult> {
  // multipart/form-data upload. Don't set Content-Type manually — the
  // fetch boundary is generated when the browser/RN builds the body.
  const form = new FormData();
  // React Native's FormData accepts an object with { uri, name, type }
  // for file fields; the cast to any is the standard workaround for the
  // type mismatch with DOM FormData.
  form.append("audio", {
    uri,
    name: "recording.m4a",
    type: mimeType,
  } as unknown as Blob);

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  // Bypass authFetch because it sets Content-Type: application/json
  // unconditionally, which breaks the multipart boundary.
  const res = await fetch(`${API_BASE_URL}${V1}/voice/transcribe`, {
    method: "POST",
    headers,
    body: form,
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as TranscriptionResult;
}

export interface ChatResponse {
  reply: string;
  session_id: string;
  intent: string;
  agent_used: string | null;
  data: Record<string, unknown> | null;
}

export async function chatMessage(
  message: string,
  source: "voice" | "text" = "text",
  sessionId?: string,
): Promise<ChatResponse> {
  // Send the device's IANA timezone so the LLM can interpret
  // user-stated times like "4 PM" in local time. Falling back to
  // undefined when the runtime lacks Intl is fine — the backend then
  // assumes UTC, which is the pre-fix behaviour.
  let userTimezone: string | undefined;
  try {
    userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    userTimezone = undefined;
  }
  const body = {
    message,
    source,
    session_id: sessionId,
    user_timezone: userTimezone,
  };
  const res = await authFetch(`${V1}/chat`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ChatResponse;
}

export interface UpdateTaskInput {
  title?: string;
  label?: string | null;
  description?: string | null;
  status?: ServerTaskStatus;
  due_at?: string | null;
  importance?: number;
  parent_cluster_id?: string | null;
}

export async function updateTask(id: string, patch: UpdateTaskInput): Promise<ServerTask> {
  const res = await authFetch(`${V1}/tasks/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ServerTask;
}

export async function deleteTask(id: string): Promise<void> {
  const res = await authFetch(`${V1}/tasks/${id}`, { method: "DELETE" });
  // 204 No Content is the documented success response; 404 is acceptable
  // because the caller may have already optimistically removed it locally.
  if (!res.ok && res.status !== 404) throw await parseError(res);
}

export interface VoiceUpdateResponse {
  // Sparse patch — only the fields the LLM thought should change.
  // Each is optional; due_at can also be explicit null to clear.
  patch: {
    title?: string;
    label?: string | null;
    description?: string | null;
    due_at?: string | null;
    importance?: number;
  };
  reply: string;
}

export async function voiceUpdateTask(
  id: string,
  transcript: string,
): Promise<VoiceUpdateResponse> {
  let userTimezone: string | undefined;
  try {
    userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    userTimezone = undefined;
  }
  const res = await authFetch(`${V1}/tasks/${id}/voice-update`, {
    method: "POST",
    body: JSON.stringify({ transcript, user_timezone: userTimezone }),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as VoiceUpdateResponse;
}

export async function createTask(input: CreateTaskInput): Promise<ServerTask> {
  // owner_id is required by the Pydantic model but the router overrides
  // it with the JWT subject — we still have to send a value to satisfy
  // validation. Pulling it from the session here so callers don't repeat
  // this boilerplate.
  const { data } = await supabase.auth.getSession();
  const ownerId = data.session?.user.id;
  if (!ownerId) {
    throw new ApiError(401, "Not authenticated.", "NOT_AUTHENTICATED");
  }
  const body = {
    owner_id: ownerId,
    title: input.title,
    label: input.label ?? null,
    description: input.description ?? null,
    parent_cluster_id: input.parent_cluster_id ?? null,
    due_at: input.due_at ?? null,
    importance: input.importance ?? 5,
    source_type: "manual",
  };
  const res = await authFetch(`${V1}/tasks`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ServerTask;
}
