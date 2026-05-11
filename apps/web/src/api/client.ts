// Armin Mehri — mehri.armin@gmail.com
import axios, { AxiosError, AxiosHeaders, type AxiosInstance } from "axios";
import { useAuth } from "@/auth/store";

const baseURL = import.meta.env.VITE_API_BASE ?? "/api";

// v3.30 — every API call must finish or fail within 30 seconds. Without
// a timeout, a hung backend / proxy / MinIO presign keeps the request
// in-flight forever, which (a) blocks React Query's success path and
// (b) keeps Chrome's tab loading-indicator spinning. The few endpoints
// that legitimately run longer (long-running batch jobs) already poll
// short status calls instead of holding one request open, so a 30 s
// ceiling is safe across the surface.
const REQUEST_TIMEOUT_MS = 30_000;

export const api: AxiosInstance = axios.create({
  baseURL,
  timeout: REQUEST_TIMEOUT_MS,
});

api.interceptors.request.use((config) => {
  const token = useAuth.getState().accessToken;
  if (token) {
    config.headers = config.headers ?? new AxiosHeaders();
    config.headers.set("Authorization", `Bearer ${token}`);
  }
  return config;
});

let refreshing: Promise<string | null> | null = null;

/**
 * Send the user to the login page and clear stored tokens. Audit bug T:
 * previously, when the refresh endpoint also returned 401 we only
 * cleared local state, leaving the user on a half-broken page until
 * they navigated manually. Now we kick them to /login.
 *
 * Guarded against test environments where ``window.location.assign``
 * may be missing or stubbed — falls back to setting ``href`` and to a
 * silent no-op when navigation is unavailable. Skips when already on
 * /login to avoid an infinite redirect loop.
 */
function redirectToLogin(): void {
  try {
    if (typeof window === "undefined" || !window.location) return;
    if (window.location.pathname === "/login") return;
    if (typeof window.location.assign === "function") {
      window.location.assign("/login");
    } else {
      window.location.href = "/login";
    }
  } catch {
    /* navigation unavailable in this environment */
  }
}

api.interceptors.response.use(
  (r) => r,
  async (error: AxiosError) => {
    const original = error.config as (typeof error.config & { __retried?: boolean }) | undefined;
    if (error.response?.status === 401 && original && !original.__retried) {
      const refresh = useAuth.getState().refreshToken;
      if (!refresh) {
        useAuth.getState().clear();
        redirectToLogin();
        return Promise.reject(error);
      }
      refreshing ??= (async () => {
        try {
          const r = await axios.post(`${baseURL}/auth/refresh`, { refresh_token: refresh });
          useAuth.getState().setAccessToken(r.data.access_token);
          return r.data.access_token as string;
        } catch {
          useAuth.getState().clear();
          return null;
        } finally {
          refreshing = null;
        }
      })();
      const newToken = await refreshing;
      if (!newToken) {
        // Refresh also failed — kick the user to /login instead of
        // leaving them on a half-broken page. Audit bug T.
        redirectToLogin();
        return Promise.reject(error);
      }
      original.__retried = true;
      original.headers = original.headers ?? new AxiosHeaders();
      (original.headers as AxiosHeaders).set("Authorization", `Bearer ${newToken}`);
      return api.request(original);
    }
    return Promise.reject(error);
  },
);
