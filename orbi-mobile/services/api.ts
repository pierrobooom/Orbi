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
