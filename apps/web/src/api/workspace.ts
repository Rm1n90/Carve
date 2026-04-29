import { api } from "./client";

/**
 * v3.1 Bug 6 — singleton workspace API client.
 *
 * Backed by ``GET /workspace`` and ``PATCH /workspace`` on the API.
 * Read access is for any authenticated user; PATCH is admin-only.
 */

export interface Workspace {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  members_count: number;
}

export interface WorkspaceUpdate {
  name?: string;
  description?: string;
}

export const workspaceApi = {
  get: async (): Promise<Workspace> =>
    (await api.get<Workspace>("/workspace")).data,
  update: async (patch: WorkspaceUpdate): Promise<Workspace> =>
    (await api.patch<Workspace>("/workspace", patch)).data,
};
