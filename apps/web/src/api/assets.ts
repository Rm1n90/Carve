import { api } from "./client";

export type AssetKind = "image" | "video";
export type AssetStatusFilter = "all" | "annotated" | "unannotated";

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
  thumbnail_url: string | null;
}

export interface AssetWithUrl {
  asset: Asset;
  url: string;
}

export interface AssetListPage {
  items: Asset[];
  total: number;
  limit: number;
  offset: number;
}

export interface AssetCountResponse {
  total: number;
  annotated: number;
  unannotated: number;
}

export interface ListAssetsParams {
  limit?: number;
  offset?: number;
  q?: string;
  status?: AssetStatusFilter;
}

export const assetsApi = {
  /**
   * Paginated list with optional search + status filter. Default limit is
   * 100 to keep the v2.4 grid responsive even with 10K+ assets.
   */
  listPage: async (
    taskId: string,
    params: ListAssetsParams = {},
  ): Promise<AssetListPage> => {
    const { limit = 100, offset = 0, q, status } = params;
    const search = new URLSearchParams();
    search.set("limit", String(limit));
    search.set("offset", String(offset));
    if (q) search.set("q", q);
    if (status && status !== "all") search.set("status", status);
    return (
      await api.get<AssetListPage>(`/tasks/${taskId}/assets?${search.toString()}`)
    ).data;
  },
  /**
   * Compatibility helper: returns just the items array. Callers that need
   * pagination metadata should use `listPage` directly.
   */
  listForTask: async (taskId: string): Promise<Asset[]> =>
    (await assetsApi.listPage(taskId, { limit: 500 })).items,
  count: async (taskId: string): Promise<AssetCountResponse> =>
    (await api.get<AssetCountResponse>(`/tasks/${taskId}/assets/count`)).data,
  upload: async (taskId: string, file: File): Promise<Asset> => {
    const fd = new FormData();
    fd.append("file", file);
    return (
      await api.post<Asset>(`/tasks/${taskId}/assets`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      })
    ).data;
  },
  uploadZip: async (taskId: string, file: File): Promise<Asset[]> => {
    const fd = new FormData();
    fd.append("file", file);
    return (
      await api.post<Asset[]>(`/tasks/${taskId}/assets:zip`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      })
    ).data;
  },
  get: async (assetId: string): Promise<AssetWithUrl> =>
    (await api.get<AssetWithUrl>(`/assets/${assetId}`)).data,
  delete: async (assetId: string): Promise<void> => {
    await api.delete(`/assets/${assetId}`);
  },
};
