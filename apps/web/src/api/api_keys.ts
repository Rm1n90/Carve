// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface ApiKeyCreated extends ApiKey {
  /** Raw token. Returned only once at creation time. */
  token: string;
}

export const apiKeysApi = {
  list: async (): Promise<ApiKey[]> =>
    (await api.get<ApiKey[]>("/auth/api-keys")).data,
  create: async (name: string): Promise<ApiKeyCreated> =>
    (await api.post<ApiKeyCreated>("/auth/api-keys", { name })).data,
  revoke: async (id: string): Promise<void> => {
    await api.delete(`/auth/api-keys/${id}`);
  },
};
