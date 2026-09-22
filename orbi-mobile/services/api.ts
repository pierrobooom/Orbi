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
import { File } from "expo-file-system";

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
  /** Ordering token — never a timestamp, never displayed.
   *
   * Bank feeds carry a date but no time, so this preserves the order the
   * provider returned. Without it, several transfers made on the same day
   * have nothing to sort by and shuffle between refreshes. Null for manual
   * entries: sort those last and fall back to created_at. */
  sort_key: number | null;
  account_id: string | null;
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

// ---------------------------------------------------------------------------
// Accounts, recurring rules, bank connections
// ---------------------------------------------------------------------------

export interface FinanceAccount {
  id: string;
  owner_id: string;
  name: string;
  /** Display label and the key imported transactions are matched on.
   *
   * NOT a credential. An IBAN is the address printed on an invoice — it
   * says which account, never that anyone agreed to share it. Reading an
   * account needs the holder to authenticate at their own bank; that flow
   * produces a connection, not this field. */
  iban: string | null;
  currency: string;
  is_primary: boolean;
  visible: boolean;
  include_in_total: boolean;
  position: number;
  opening_balance: number;
  created_at: string;
}

export interface AccountBalance {
  account: FinanceAccount;
  /** Derived server-side from opening_balance + entries, never stored. */
  balance: number;
  entry_count: number;
}

export interface CreateAccountInput {
  name: string;
  iban?: string | null;
  currency?: string;
  is_primary?: boolean;
  visible?: boolean;
  include_in_total?: boolean;
  opening_balance?: number;
}

export type UpdateAccountInput = Partial<
  Omit<CreateAccountInput, "currency">
> & { position?: number };

export async function listAccounts(): Promise<AccountBalance[]> {
  const res = await authFetch(`${V1}/finance/accounts`);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as AccountBalance[];
}

export async function createAccount(
  input: CreateAccountInput,
): Promise<FinanceAccount> {
  const res = await authFetch(`${V1}/finance/accounts`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as FinanceAccount;
}

export async function updateAccount(
  id: string,
  patch: UpdateAccountInput,
): Promise<FinanceAccount> {
  const res = await authFetch(`${V1}/finance/accounts/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as FinanceAccount;
}

export async function deleteAccount(id: string): Promise<void> {
  const res = await authFetch(`${V1}/finance/accounts/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw await parseError(res);
}

export type Cadence = "weekly" | "monthly" | "yearly";

export interface RecurringTransaction {
  id: string;
  owner_id: string;
  account_id: string | null;
  merchant: string;
  category: string;
  amount: number;
  currency: string;
  entry_type: "income" | "expense";
  notes: string | null;
  cadence: Cadence;
  interval_count: number;
  next_run_on: string;
  last_run_on: string | null;
  end_on: string | null;
  active: boolean;
  /** Warn before this renews — 4 days out, 2, 1, and a receipt on the day.
   * Separate from `active`: rent is live and silent, a gym is live and
   * loud, and only the user knows which is which. */
  notify_enabled: boolean;
}

export interface CreateRecurringInput {
  account_id?: string | null;
  merchant: string;
  category: string;
  amount: number;
  currency?: string;
  entry_type?: "income" | "expense";
  notes?: string | null;
  cadence?: Cadence;
  interval_count?: number;
  next_run_on: string;
  end_on?: string | null;
}

export async function listRecurring(): Promise<RecurringTransaction[]> {
  const res = await authFetch(`${V1}/finance/recurring`);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as RecurringTransaction[];
}

export async function createRecurring(
  input: CreateRecurringInput,
): Promise<RecurringTransaction> {
  const res = await authFetch(`${V1}/finance/recurring`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as RecurringTransaction;
}

export async function updateRecurring(
  id: string,
  patch: Partial<CreateRecurringInput> & {
    active?: boolean;
    notify_enabled?: boolean;
  },
): Promise<RecurringTransaction> {
  const res = await authFetch(`${V1}/finance/recurring/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as RecurringTransaction;
}

export async function deleteRecurring(id: string): Promise<void> {
  const res = await authFetch(`${V1}/finance/recurring/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw await parseError(res);
}

export interface SpendingLimit {
  id: string;
  category: string;
  monthly_limit: number;
  alert_threshold: number;
  alerts_enabled: boolean;
  /** Summed from entries on every read, never a stored running total — that
   * drifts the moment an entry is edited or deleted. */
  spent: number;
  remaining: number;
  /** Null when the limit is zero, so the UI never divides by it. */
  fraction: number | null;
}

export async function getLimits(): Promise<{
  month: string;
  limits: SpendingLimit[];
}> {
  const res = await authFetch(`${V1}/finance/limits`);
  if (!res.ok) throw await parseError(res);
  return await res.json();
}

/** Create or change a category's monthly ceiling.
 *
 * Upsert by category, so the caller never has to check whether one already
 * exists before setting it. */
export async function upsertLimit(
  category: string,
  monthlyLimit: number,
  options?: { alert_threshold?: number; alerts_enabled?: boolean },
): Promise<void> {
  const res = await authFetch(`${V1}/finance/limits`, {
    method: "PUT",
    body: JSON.stringify({
      category,
      monthly_limit: monthlyLimit,
      alert_threshold: options?.alert_threshold ?? 0.8,
      alerts_enabled: options?.alerts_enabled ?? true,
    }),
  });
  if (!res.ok) throw await parseError(res);
}

export async function deleteLimit(id: string): Promise<void> {
  const res = await authFetch(`${V1}/finance/limits/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw await parseError(res);
}

export interface DashboardCategory {
  category: string;
  amount: number;
  share_pct: number;
  /** Null when there is no history to compare against — which is a different
   * answer from "unchanged" and must render differently. */
  average: number | null;
  change_pct: number | null;
}

export interface FinanceDashboard {
  month: string;
  total_spend: number;
  total_income: number;
  net: number;
  average_spend: number | null;
  spend_change_pct: number | null;
  months_compared: number;
  categories: DashboardCategory[];
  top_merchants: { merchant: string; amount: number; count: number }[];
  daily: { date: string; amount: number }[];
  entry_count: number;
  uncategorised_count: number;
}

/** Spending for a month, against the months before it.
 *
 * Every figure is computed server-side from the user's own rows. Scoped to
 * one account when given, because "what did I spend" and "what did I spend
 * on this card" are different questions. */
export async function getFinanceDashboard(
  month?: string,
  accountId?: string | null,
): Promise<FinanceDashboard> {
  const params = new URLSearchParams();
  if (month) params.set("month", month);
  if (accountId) params.set("account_id", accountId);
  const qs = params.toString();
  const res = await authFetch(`${V1}/finance/dashboard${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as FinanceDashboard;
}

export interface ProviderStatus {
  provider: string;
  /** What the client should render where a Connect button would go.
   *
   * A button that produces a refusal is worse than a line of text saying
   * why — so the server decides, and the UI renders the reason. */
  can_connect: boolean;
  gate: "ok" | "coming_soon" | "upgrade" | "limit" | "no_provider";
  account_limit: number;
  connected_accounts: number;
  /** False when no aggregator is configured — nothing will sync, and the
   * UI should say so rather than offering a Connect button to nowhere. */
  automatic_import: boolean;
  note: string;
}

export async function getProviderStatus(): Promise<ProviderStatus> {
  const res = await authFetch(`${V1}/finance/provider`);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ProviderStatus;
}

export interface ApprovedAccount {
  uid: string;
  /** Masked — enough to recognise which account, not the full number. */
  masked_iban: string | null;
  name: string | null;
  currency: string | null;
}

export interface BankConnection {
  id: string;
  owner_id: string;
  account_id: string;
  provider: string;
  institution_id: string | null;
  /** "choose" means the bank approved access and returned several accounts:
   * the consent is live, and only the mapping is missing. Not an error. */
  status: "pending" | "active" | "choose" | "expired" | "revoked" | "error";
  consent_expires_at: string | null;
  last_synced_at: string | null;
  next_sync_after: string | null;
  last_error: string | null;
  /** Present only while status is "choose". */
  approved_accounts?: ApprovedAccount[] | null;
}

/** Say which of the bank's approved accounts this Orbi account is.
 *
 * Only reachable from the "choose" state, where the consent already exists
 * and the single missing fact is the mapping — which is the one thing the
 * server cannot safely work out on its own. */
export async function chooseConnectionAccount(
  connectionId: string,
  uid: string,
): Promise<BankConnection> {
  const res = await authFetch(
    `${V1}/finance/connections/${connectionId}/choose`,
    { method: "POST", body: JSON.stringify({ uid }) },
  );
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as BankConnection;
}

export interface ConnectResponse {
  connection: BankConnection;
  /** Where the user must go to sign in with their bank and approve access.
   *
   * Present for every real provider — that trip is what produces the token
   * syncing needs, and an account number can never substitute for it. Absent
   * only for the sandbox, which talks to no bank. */
  authorization_url: string | null;
  message: string;
}

export async function listBankConnections(): Promise<BankConnection[]> {
  const res = await authFetch(`${V1}/finance/connections`);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as BankConnection[];
}

/** Connections the user has to act on: expired, errored, or ending soon.
 *
 * Worth its own call from screens that show totals. A feed that has quietly
 * stopped is indistinguishable from a quiet month, so the number stays
 * trusted long after it stopped being true. */
export async function connectionsNeedingAttention(): Promise<BankConnection[]> {
  const res = await authFetch(`${V1}/finance/connections/attention`);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as BankConnection[];
}

export interface Institution {
  name: string;
  country: string;
  logo: string | null;
  /** "personal" / "business". A bank listed for business customers only
   * fails at the bank's own login with a confusing error, so the server
   * filters to personal before this ever arrives. */
  psu_types: string[];
}

/** The banks this user can connect to, in a given country.
 *
 * Fetched live rather than shipped in the bundle: providers add and remove
 * institutions continuously, and a stale list offers people a bank they
 * cannot actually connect to. */
export async function listInstitutions(country: string): Promise<Institution[]> {
  const res = await authFetch(
    `${V1}/finance/institutions?country=${encodeURIComponent(country)}`,
  );
  if (!res.ok) throw await parseError(res);
  const body = (await res.json()) as { institutions: Institution[] };
  return body.institutions ?? [];
}

/** Start linking an account to the configured bank provider.
 *
 * An account and a connection are different things: an account is a label to
 * file transactions against, a connection is permission to fetch them.
 * Syncing iterates connections, so an account alone never produces anything.
 *
 * The institution is required in practice even though the API allows it to be
 * omitted: leaving it out falls back to a server-wide default, which sends
 * every user to one bank. Fine for a single developer, wrong for user two. */
export async function connectAccount(
  accountId: string,
  bank?: { institution: string; country: string },
): Promise<ConnectResponse> {
  const res = await authFetch(`${V1}/finance/accounts/${accountId}/connect`, {
    method: "POST",
    body: JSON.stringify(
      bank ? { institution: bank.institution, country: bank.country } : {},
    ),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ConnectResponse;
}

export async function disconnectBank(connectionId: string): Promise<void> {
  const res = await authFetch(`${V1}/finance/connections/${connectionId}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) throw await parseError(res);
}

export interface ImportResult {
  parsed: number;
  imported: number;
  /** Already present. Expected on a re-import, not a failure. */
  duplicates: number;
  skipped_pending: number;
  skipped_unreadable: number;
}

/** Import transactions from a statement the user exported from their bank.
 *
 * The route to real data that needs no licence and no aggregator — the user
 * already has the file and hands it over deliberately. Safe to run twice:
 * transaction ids are a hash of date, amount and description, so an
 * overlapping export writes each transaction once. */
export async function importStatement(
  accountId: string,
  content: string,
): Promise<ImportResult> {
  const res = await authFetch(`${V1}/finance/accounts/${accountId}/import`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ImportResult;
}

export interface FinanceJobResult {
  recurring_rules: number;
  recurring_entries: number;
  sync: { considered: number; imported: number; failed: number };
  /** Every connection was checked too recently to ask again.
   *
   * Reported so the client can say "already up to date" rather than
   * "0 imported", which reads as a failure. */
  throttled: boolean;
}

/** Run the daily finance jobs now.
 *
 * Does NOT bypass the per-account sync cooldown, so tapping it repeatedly
 * cannot run up a provider bill. */
export async function runFinanceJobs(): Promise<FinanceJobResult> {
  const res = await authFetch(`${V1}/finance/run-jobs`, { method: "POST" });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as FinanceJobResult;
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
  // Set when the task was marked complete (migration 0010). Optional so
  // rows completed before that column existed still type-check; the
  // Done view falls back to updated_at for those.
  completed_at?: string | null;
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
  // Stored server-side since migration 0007. Optional so a stale client
  // reading a pre-0007 row still type-checks; universeLayout falls back
  // to name classification when it's missing.
  kind?: string | null;
  weight_score: number;
  active_count: number;
  parent_cluster_id: string | null;
  created_at: string;
  // Since migration 0011. Optional so a stale client reading a pre-0011
  // row still type-checks; absent reads as not muted.
  notifications_muted?: boolean;
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
  notifications_muted?: boolean;
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
  language?: string | null,
): Promise<TranscriptionResult> {
  // multipart/form-data upload. Don't set Content-Type manually — the
  // fetch boundary is generated when the browser/RN builds the body.
  const form = new FormData();
  // React Native 0.86 (Expo SDK 57) ships a spec-compliant FormData that
  // rejects the old RN-only `{ uri, name, type }` object with
  // "Unsupported FormDataPart implementation". expo-file-system's File
  // class implements Blob, so it can be appended directly — which is the
  // supported replacement rather than a workaround.
  const file = new File(uri);
  form.append("audio", file, "recording.m4a");
  // Sent explicitly rather than relying on the Blob's inferred type: the
  // backend passes this to Deepgram, and an inferred
  // "application/octet-stream" is the difference between a transcript and
  // a rejected upload.
  form.append("mimetype", mimeType);

  // Deepgram can't infer the language from the audio, so it has to be
  // sent with the upload. Omitted means "use my stored preference".
  if (language) form.append("language", language);

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

export const SUPPORTED_LANGUAGES = [
  { tag: "en-GB", label: "English (UK)" },
  { tag: "en-US", label: "English (US)" },
  { tag: "pt-PT", label: "Português (Portugal)" },
] as const;

export type LanguageTag = (typeof SUPPORTED_LANGUAGES)[number]["tag"];

export interface UserPreferences {
  user_id: string;
  // "HH:MM:SS". The window normally wraps midnight (22:00 -> 08:00).
  quiet_hours_start: string;
  quiet_hours_end: string;
  // 1-5. The server turns this into a hard ceiling on notifications per
  // day — see REMINDER_DENSITY below for the mapping the UI shows.
  proactivity_level: number;
  preferred_reminder_channel: string;
  language: LanguageTag;
  reminders_enabled: boolean;
  lead_reminders_enabled: boolean;
  chase_reminders_enabled: boolean;
  /** Mirrors where controls sit so the likely ones fall inside the thumb's
   * arc. Presentation only — never what an action does. */
  handedness: "right" | "left";
  // IANA zone. Quiet hours are zone-less times, so the background
  // dispatcher cannot interpret them without this — the client is the only
  // thing that knows where the device is.
  timezone: string;
}

/** How proactivity_level reads to a human. Mirrors _DAILY_BUDGET in
 * services/reminder_schedule.py — if that changes, change this. */
export const REMINDER_DENSITY: Record<number, { label: string; perDay: number }> = {
  1: { label: "Minimal", perDay: 2 },
  2: { label: "Light", perDay: 4 },
  3: { label: "Balanced", perDay: 6 },
  4: { label: "Attentive", perDay: 10 },
  5: { label: "Insistent", perDay: 20 },
};

export const DEFAULT_PREFERENCES: UserPreferences = {
  user_id: "",
  quiet_hours_start: "22:00:00",
  quiet_hours_end: "08:00:00",
  proactivity_level: 3,
  preferred_reminder_channel: "push",
  language: "en-GB",
  reminders_enabled: true,
  lead_reminders_enabled: true,
  chase_reminders_enabled: true,
  handedness: "right",
  timezone: "UTC",
};

export interface NotificationPlan {
  id: string;
  task_id: string;
  kind: "lead" | "due" | "chase" | "escalate";
  trigger_at: string;
  state: "pending" | "sent" | "answered" | "cancelled" | "skipped";
  snooze_count: number;
  sent_at: string | null;
}

export interface NotificationPlanList {
  plans: NotificationPlan[];
  daily_budget: number;
}

/** The caller's scheduled and recently sent reminders. */
export async function getNotificationPlans(): Promise<NotificationPlanList> {
  const res = await authFetch(`${V1}/notifications/plans`);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as NotificationPlanList;
}

/** Recompute every reminder from the current settings.
 *
 * The server already resyncs on its own when a schedule-affecting
 * preference is saved; this is for the manual "my reminders look wrong"
 * escape hatch. */
export async function resyncNotificationPlans(): Promise<{
  tasks_considered: number;
  plans_scheduled: number;
}> {
  const res = await authFetch(`${V1}/notifications/resync`, { method: "POST" });
  if (!res.ok) throw await parseError(res);
  return await res.json();
}

/** Push a reminder back and let it fire again.
 *
 * Re-arms the same plan rather than creating a new one, so snooze_count
 * keeps climbing — that count is the signal a task is being avoided
 * rather than done. */
export async function snoozeNotification(
  planId: string,
  minutes: number,
): Promise<NotificationPlan> {
  const res = await authFetch(`${V1}/notifications/${planId}/snooze`, {
    method: "POST",
    body: JSON.stringify({ minutes }),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as NotificationPlan;
}

/** Record that the user dealt with a reminder without completing the task.
 *
 * Stops the escalation without claiming the work is done — "seen it, not
 * yet" is a real answer. */
export async function markNotificationAnswered(
  planId: string,
): Promise<NotificationPlan> {
  const res = await authFetch(`${V1}/notifications/${planId}/answered`, {
    method: "POST",
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as NotificationPlan;
}

export async function getMyPreferences(): Promise<UserPreferences> {
  const res = await authFetch(`${V1}/users/me/preferences`);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as UserPreferences;
}

/** Partial update. The server merges over the stored row and takes
 * user_id from the auth token, so send only what's changing. */
export type UserPreferencesPatch = Partial<Omit<UserPreferences, "user_id">>;

export async function setMyPreferences(
  prefs: UserPreferencesPatch,
): Promise<UserPreferences> {
  const res = await authFetch(`${V1}/users/me/preferences`, {
    method: "PUT",
    body: JSON.stringify(prefs),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as UserPreferences;
}

/** Permanently delete the account and every row it owns.
 *
 * confirmEmail must match the account email exactly — the server rejects
 * anything else. Apple requires in-app account deletion for any app that
 * offers account creation. */
export async function deleteMyAccount(confirmEmail: string): Promise<void> {
  const res = await authFetch(`${V1}/users/me/delete`, {
    method: "POST",
    body: JSON.stringify({ confirm_email: confirmEmail }),
  });
  if (!res.ok) throw await parseError(res);
}

export interface ServerMemoryNode {
  id: string;
  user_id: string;
  content: string;
  memory_type: string;
  tags: string[];
  importance: number;
  source_summary: string | null;
  created_at: string;
  updated_at: string;
}

export async function listMemories(limit = 50): Promise<ServerMemoryNode[]> {
  const res = await authFetch(`${V1}/memory?limit=${limit}`);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ServerMemoryNode[];
}

export async function deleteMemory(id: string): Promise<void> {
  const res = await authFetch(`${V1}/memory/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw await parseError(res);
}

export interface ChatHistoryMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  intent: string | null;
  /** "voice", "text", "receipt"… A spoken sentence and a typed one look
   * identical once transcribed, so the chat has to say which it was. */
  source: string | null;
  created_at: string;
}

export interface ChatHistoryResponse {
  session_id: string | null;
  messages: ChatHistoryMessage[];
}

/** Past messages for a session, oldest first. Omit sessionId for the
 * most recent conversation — what opening the Chat tab should show. */
export async function getChatHistory(
  sessionId?: string,
  limit = 50,
): Promise<ChatHistoryResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (sessionId) params.set("session_id", sessionId);
  const res = await authFetch(`${V1}/chat/history?${params.toString()}`);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ChatHistoryResponse;
}

export async function chatMessage(
  message: string,
  source: "voice" | "text" = "text",
  sessionId?: string,
  /** Ask the server to retrieve the user's tasks and give them to the
   * model, so it can ANSWER questions rather than only route them. Costs
   * ~500 extra tokens per call, so the Chat tab opts in and the Universe
   * mic does not — capturing "buy milk" needs no task list. */
  includeContext = false,
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
    include_context: includeContext,
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

export interface DraftTaskInput {
  title: string;
  label?: string | null;
  description?: string | null;
  due_at?: string | null;
  importance?: number | null;
}

/** Apply a spoken correction to a task that hasn't been created yet.
 * Read-only server-side — returns a patch for the confirm screen to
 * merge into its pending task. */
export async function draftVoiceUpdate(
  draft: DraftTaskInput,
  transcript: string,
): Promise<VoiceUpdateResponse> {
  let userTimezone: string | undefined;
  try {
    userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    userTimezone = undefined;
  }
  const res = await authFetch(`${V1}/tasks/draft-voice-update`, {
    method: "POST",
    body: JSON.stringify({ draft, transcript, user_timezone: userTimezone }),
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

export interface SpendingInsight {
  /** Deterministic rules are computed per request and have no row behind
   * them, so they have no id and cannot be dismissed. Only the AI-generated
   * ones are stored. */
  id?: string;
  insight_text: string;
  category: string;
  subject: string | null;
  severity: "info" | "warning" | "alert";
  period?: string | null;
  created_at?: string;
}

export interface InsightsResponse {
  month: string;
  insights: SpendingInsight[];
  /** False on Spark. The deterministic half still arrives — the screen says
   * what the tier adds rather than looking broken. */
  ai_available: boolean;
  ai_generated: boolean;
  entry_count: number;
}

/** Observations about this month's spending.
 *
 * `refresh` asks for regeneration and is still subject to the server's
 * once-a-day window, so a user leaning on the button cannot run up a bill. */
export async function getInsights(refresh = false): Promise<InsightsResponse> {
  const res = await authFetch(
    `${V1}/finance/insights${refresh ? "?refresh=true" : ""}`,
  );
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as InsightsResponse;
}

export async function dismissInsight(id: string): Promise<void> {
  const res = await authFetch(`${V1}/finance/insights/${id}/dismiss`, {
    method: "POST",
  });
  if (!res.ok && res.status !== 404) throw await parseError(res);
}

export interface BreakdownVendor {
  name: string;
  amount: number;
  count: number;
  category: string | null;
}

export interface BreakdownCategory {
  category: string;
  amount: number;
  count: number;
}

export interface SpendingBreakdown {
  month: string;
  vendors: BreakdownVendor[];
  categories: BreakdownCategory[];
  total: number;
}

/** Every vendor and every category for a month, not just the top few.
 *
 * The dashboard summarises; this is the full list, for when the question is
 * "how much have I actually spent at X". */
export async function getSpendingBreakdown(
  month?: string,
): Promise<SpendingBreakdown> {
  const res = await authFetch(
    `${V1}/finance/breakdown${month ? `?month=${month}` : ""}`,
  );
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as SpendingBreakdown;
}

export interface FinanceCategory {
  id: string;
  slug: string;
  label: string;
  icon: string | null;
  color: string | null;
  /** Seeded categories can be renamed and hidden but never deleted: entries
   * and budgets already point at their slugs. */
  is_default: boolean;
  hidden: boolean;
  position: number;
}

/** This user's categories. Seeded server-side on first read. */
export async function listCategories(): Promise<FinanceCategory[]> {
  const res = await authFetch(`${V1}/finance/categories`);
  if (!res.ok) throw await parseError(res);
  const body = (await res.json()) as { categories: FinanceCategory[] };
  return body.categories ?? [];
}

export async function createCategory(input: {
  label: string;
  icon?: string;
  color?: string;
}): Promise<FinanceCategory> {
  const res = await authFetch(`${V1}/finance/categories`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as FinanceCategory;
}

export async function updateCategory(
  id: string,
  patch: { label?: string; icon?: string; color?: string; hidden?: boolean },
): Promise<FinanceCategory> {
  const res = await authFetch(`${V1}/finance/categories/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as FinanceCategory;
}

export async function deleteCategory(id: string): Promise<void> {
  const res = await authFetch(`${V1}/finance/categories/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw await parseError(res);
}

export interface RecategoriseResult {
  examined: number;
  categorised: number;
  /** False when the rules alone did it, or when the tier has no AI. */
  used_ai: boolean;
  remaining: number;
}

/** Have another go at everything still uncategorised.
 *
 * Cheap passes first — what the user has taught us, then the static rules —
 * and only what survives both reaches a model, in one batched call. */
export async function recategorise(): Promise<RecategoriseResult> {
  const res = await authFetch(`${V1}/finance/categories/recategorise`, {
    method: "POST",
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as RecategoriseResult;
}
