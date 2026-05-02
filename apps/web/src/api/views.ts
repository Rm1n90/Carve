// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";

export type SavedViewQuery = {
  status?: "proposed" | "accepted" | "rejected";
  class_id?: string;
  min_size?: number;
  max_size?: number;
  q?: string;
};

export interface SavedView {
  id: string;
  task_id: string;
  owner: string | null;
  name: string;
  query: SavedViewQuery;
  shared: boolean;
  created_at: string;
  updated_at: string;
}

export interface SavedViewIn {
  name: string;
  query: SavedViewQuery;
  shared?: boolean;
}

export interface SavedViewPatch {
  name?: string;
  query?: SavedViewQuery;
  shared?: boolean;
}

export const viewsApi = {
  list: async (taskId: string): Promise<SavedView[]> =>
    (await api.get<SavedView[]>(`/tasks/${taskId}/views`)).data,
  create: async (taskId: string, payload: SavedViewIn): Promise<SavedView> =>
    (await api.post<SavedView>(`/tasks/${taskId}/views`, payload)).data,
  get: async (viewId: string): Promise<SavedView> =>
    (await api.get<SavedView>(`/views/${viewId}`)).data,
  patch: async (viewId: string, payload: SavedViewPatch): Promise<SavedView> =>
    (await api.patch<SavedView>(`/views/${viewId}`, payload)).data,
  remove: async (viewId: string): Promise<void> => {
    await api.delete(`/views/${viewId}`);
  },
};
