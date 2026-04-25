import { api } from "@/api/client";
import { useAuth, type User } from "./store";

interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: string;
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
  useAuth.getState().setSession({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    user: me,
  });
}

export function logout(): void {
  useAuth.getState().clear();
}
