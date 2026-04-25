import axios, { AxiosError, AxiosHeaders, type AxiosInstance } from "axios";
import { useAuth } from "@/auth/store";

const baseURL = import.meta.env.VITE_API_BASE ?? "/api";

export const api: AxiosInstance = axios.create({ baseURL });

api.interceptors.request.use((config) => {
  const token = useAuth.getState().accessToken;
  if (token) {
    config.headers = config.headers ?? new AxiosHeaders();
    config.headers.set("Authorization", `Bearer ${token}`);
  }
  return config;
});

let refreshing: Promise<string | null> | null = null;

api.interceptors.response.use(
  (r) => r,
  async (error: AxiosError) => {
    const original = error.config as (typeof error.config & { __retried?: boolean }) | undefined;
    if (error.response?.status === 401 && original && !original.__retried) {
      const refresh = useAuth.getState().refreshToken;
      if (!refresh) {
        useAuth.getState().clear();
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
      if (!newToken) return Promise.reject(error);
      original.__retried = true;
      original.headers = original.headers ?? new AxiosHeaders();
      (original.headers as AxiosHeaders).set("Authorization", `Bearer ${newToken}`);
      return api.request(original);
    }
    return Promise.reject(error);
  },
);
