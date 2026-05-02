import { api } from "./client";

export interface SearchAssetHit {
  asset_id: string;
  project_id: string;
  project_name: string;
  task_id: string;
  task_name: string;
  original_name: string;
  kind: "image" | "video";
  thumbnail_url: string | null;
  match_snippet: string | null;
}

export interface SearchAssetsPage {
  items: SearchAssetHit[];
  next_cursor: string | null;
}

export interface SearchAssetsParams {
  q?: string;
  workspace?: boolean;
  project_id?: string;
  task_id?: string;
  kind?: "image" | "video";
  class_id?: string;
  min_size?: number;
  max_size?: number;
  status?: "proposed" | "accepted" | "rejected";
  limit?: number;
  cursor?: string;
}

export const searchApi = {
  assets: async (params: SearchAssetsParams): Promise<SearchAssetsPage> => {
    const r = await api.get<SearchAssetsPage>("/search/assets", { params });
    return r.data;
  },
};
