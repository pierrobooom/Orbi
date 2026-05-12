// Backend API client.
//
// Resolves the FastAPI base URL from Expo's dev server hostname so the
// phone in Expo Go can reach the laptop on the LAN. In dev:
//   - Expo dev server runs on <laptop-LAN-ip>:8081
//   - FastAPI runs on <laptop-LAN-ip>:8000
// We pull the host from `Constants.expoConfig.hostUri` and rewrite the
// port. In production this will be replaced with a fixed cloud URL.

import Constants from "expo-constants";

function resolveBaseUrl(): string {
  const hostUri =
    Constants.expoConfig?.hostUri ??
    (Constants as unknown as { manifest2?: { extra?: { expoGo?: { developer?: { tool?: string } } } } })
      .manifest2?.extra?.expoGo?.developer?.tool;
  if (hostUri && typeof hostUri === "string") {
    const host = hostUri.split(":")[0];
    return `http://${host}:8000`;
  }
  // Fallback for cases where hostUri is not available (e.g. web preview)
  return "http://localhost:8000";
}

export const API_BASE_URL = resolveBaseUrl();

export interface HealthResponse {
  status: string;
  app: string;
}

export async function getHealth(): Promise<HealthResponse> {
  const res = await fetch(`${API_BASE_URL}/health`);
  if (!res.ok) {
    throw new Error(`Health check failed: HTTP ${res.status}`);
  }
  return (await res.json()) as HealthResponse;
}
