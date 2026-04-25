import { api } from "./client";

export type AssetKind = "image" | "video";

export interface Asset {
  id: string;
  task_id: string;
  kind: AssetKind;
  xxh3_128: string;
  mime: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  frames: number;
  original_name: string;
  created_at: string;
}

export interface AssetWithUrl {
  asset: Asset;
  url: string;
}

export const assetsApi = {
  listForTask: async (taskId: string): Promise<Asset[]> =>
    (await api.get<Asset[]>(`/tasks/${taskId}/assets`)).data,
  upload: async (taskId: string, file: File): Promise<Asset> => {
    const fd = new FormData();
    fd.append("file", file);
    return (await api.post<Asset>(`/tasks/${taskId}/assets`, fd, {
      headers: { "Content-Type": "multipart/form-data" },
    })).data;
  },
  uploadZip: async (taskId: string, file: File): Promise<Asset[]> => {
    const fd = new FormData();
    fd.append("file", file);
    return (await api.post<Asset[]>(`/tasks/${taskId}/assets:zip`, fd, {
      headers: { "Content-Type": "multipart/form-data" },
    })).data;
  },
  get: async (assetId: string): Promise<AssetWithUrl> =>
    (await api.get<AssetWithUrl>(`/assets/${assetId}`)).data,
  delete: async (assetId: string): Promise<void> => {
    await api.delete(`/assets/${assetId}`);
  },
};
