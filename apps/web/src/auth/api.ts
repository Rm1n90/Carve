// Armin Mehri — mehri.armin@gmail.com
import { api } from "@/api/client";
import { queryClient } from "@/lib/queryClient";
import { useAuth, type User } from "./store";

interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

export interface BootstrapStatus {
  users_exist: boolean;
}

export async function bootstrapStatus(): Promise<BootstrapStatus> {
  const r = await api.get<BootstrapStatus>("/auth/bootstrap-status");
  return r.data;
}

export async function register(email: string, password: string): Promise<User> {
  const r = await api.post<User>("/auth/register", { email, password });
  return r.data;
}

export async function login(email: string, password: string): Promise<void> {
  const tokens = (await api.post<TokenPair>("/auth/login", { email, password })).data;
  const me = (
    await api.get<User>("/auth/me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
  ).data;
  // Wipe any React Query cache left over from a previous session
  // BEFORE the new session is set, so we never leak the prior user's
  // projects/tasks/etc. to the new user's view.
  queryClient.clear();
  useAuth.getState().setSession({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    user: me,
  });
}

export function logout(): void {
  // Drop every cached query (the just-departing user's data) so
  // whoever logs in next starts from a blank slate.
  queryClient.clear();
  useAuth.getState().clear();
}

/**
 * Self-service password rotation (audit Bug 16). Posts to
 * ``POST /auth/password``; on success the server returns 204 with no body.
 * Errors propagate as Axios errors so callers can branch on
 * ``err.response?.status`` (401 wrong current, 422 validation, 429 rate limit).
 */
export async function changePassword(
  current_password: string,
  new_password: string,
): Promise<void> {
  await api.post("/auth/password", { current_password, new_password });
}
