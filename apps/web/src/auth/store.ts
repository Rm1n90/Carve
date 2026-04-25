import { create } from "zustand";

export type Role = "admin" | "member" | "viewer";

export interface User {
  id: string;
  email: string;
  role: Role;
}

interface Session {
  accessToken: string;
  refreshToken: string;
  user: User;
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: User | null;
  setSession: (s: Session) => void;
  setAccessToken: (t: string) => void;
  clear: () => void;
}

const ACCESS_KEY = "vaa.accessToken";
const REFRESH_KEY = "vaa.refreshToken";
const USER_KEY = "vaa.user";

function readUser(): User | null {
  const raw = localStorage.getItem(USER_KEY);
  return raw ? (JSON.parse(raw) as User) : null;
}

export const useAuth = create<AuthState>((set) => ({
  accessToken: localStorage.getItem(ACCESS_KEY),
  refreshToken: localStorage.getItem(REFRESH_KEY),
  user: readUser(),
  setSession: (s) => {
    localStorage.setItem(ACCESS_KEY, s.accessToken);
    localStorage.setItem(REFRESH_KEY, s.refreshToken);
    localStorage.setItem(USER_KEY, JSON.stringify(s.user));
    set({ accessToken: s.accessToken, refreshToken: s.refreshToken, user: s.user });
  },
  setAccessToken: (t) => {
    localStorage.setItem(ACCESS_KEY, t);
    set({ accessToken: t });
  },
  clear: () => {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
    set({ accessToken: null, refreshToken: null, user: null });
  },
}));
