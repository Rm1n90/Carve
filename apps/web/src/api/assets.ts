// Armin Mehri — mehri.armin@gmail.com
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
  /** Plan-18 — class ids of tag annotations on this asset. The grid
   *  renders these as small color dots on each thumbnail. */
  tag_class_ids?: string[];
  /** v3.26 — true when the client should kick POST /frames/extract
   *  before the editor can open this asset. Always false for images. */
  extract_required?: boolean;
}

export interface AssetWithUrl {
  asset: Asset;
  url: string;
  /**
   * For image assets, the id of the asset's single Frame row. The editor
   * scopes annotations to this frame_id so each image's bboxes/polygons
   * stay separate. Null for video assets — use the dedicated frames
   * endpoint to enumerate per-frame ids. Added in v2.5.1.
   */
  frame_id: string | null;
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

/**
 * Page size used by `listForTask` when walking a whole task. Kept well
 * under the server's per-page ceiling so each round trip stays a
 * modest JSON payload; the walk loops as many times as needed.
 */
const LIST_ALL_PAGE_SIZE = 2000;

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
   * Compatibility helper: returns EVERY asset in the task. Callers that
   * need pagination metadata should use `listPage` directly, or for
   * incremental rendering consume `listPage` via `useInfiniteQuery` (see
   * `AssetThumbnailStrip` / `AssetGrid` for examples).
   *
   * History: 500 → 5000 (v3.7) matched the backend page cap, but it was
   * still a *silent truncation* — a task with 9000 assets returned the
   * first 5000 and every consumer (editor prev/next nav, auto-annotate,
   * YOLOE, EditorToolbar) simply behaved as if the rest did not exist.
   * Now the helper walks the offset cursor until it has `total` rows, so
   * task size is bounded only by what the browser can hold, not by an
   * arbitrary constant.
   */
  listForTask: async (taskId: string): Promise<Asset[]> => {
    const items: Asset[] = [];
    let offset = 0;
    for (;;) {
      const page = await assetsApi.listPage(taskId, {
        limit: LIST_ALL_PAGE_SIZE,
        offset,
      });
      items.push(...page.items);
      // Defensive: an empty page ends the walk even if `total` is stale
      // (e.g. assets deleted mid-scan), so this can never spin forever.
      if (page.items.length === 0 || items.length >= page.total) break;
      offset = items.length;
    }
    return items;
  },
  /**
   * v3.8 Phase 4.1 -- list frames for a video asset. Track-mode commit
   * needs the {frame_idx -> frame_id} map so propagated masks land on
   * the right frame rows. Single image assets typically return one
   * frame at idx=0; videos return one row per extracted frame.
   */
  listFrames: async (
    assetId: string,
  ): Promise<
    { idx: number; frame_id: string; pts_ms: number; url: string }[]
  > =>
    (
      await api.get<
        { idx: number; frame_id: string; pts_ms: number; url: string }[]
      >(`/assets/${assetId}/frames`)
    ).data,
  /**
   * v3.8 Phase 4-video step D — Re-extract frames for a video asset
   * with the user's chosen strategy. Returns ``{job_id}``; the caller
   * polls ``GET /assets/{id}/frames`` to see the new frames land
   * (or wait for the worker to finish via a status indicator).
   */
  reextractFrames: async (
    assetId: string,
    body: {
      strategy: "all" | "every_nth" | "count" | "auto";
      n?: number | null;
      quality?: number;
    },
  ): Promise<{ job_id: string; strategy: string; n: number | null }> =>
    (
      await api.post<{ job_id: string; strategy: string; n: number | null }>(
        `/assets/${assetId}/frames/extract`,
        body,
      )
    ).data,
  /**
   * v3.8 Phase 4-video step F — live progress for the extraction job.
   * Polls the Redis hash the worker writes; returns status + decoded/
   * uploaded counters + a phase label ("decoding" / "uploading" / "done").
   */
  frameExtractStatus: async (
    assetId: string,
  ): Promise<{
    status: "running" | "completed" | "failed" | "idle";
    phase: "decoding" | "uploading" | "done" | "idle";
    decoded: number;
    expected: number;
    uploaded: number;
    message: string | null;
    job_id: string | null;
  }> =>
    (
      await api.get<{
        status: "running" | "completed" | "failed" | "idle";
        phase: "decoding" | "uploading" | "done" | "idle";
        decoded: number;
        expected: number;
        uploaded: number;
        message: string | null;
        job_id: string | null;
      }>(`/assets/${assetId}/frames/extract/status`)
    ).data,
  count: async (taskId: string): Promise<AssetCountResponse> =>
    (await api.get<AssetCountResponse>(`/tasks/${taskId}/assets/count`)).data,
  upload: async (
    taskId: string,
    file: File,
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<Asset> => {
    const fd = new FormData();
    fd.append("file", file);
    return (
      await api.post<Asset>(`/tasks/${taskId}/assets`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
        // Uploads stream large bodies (videos, zips) and can legitimately
        // run past the global 30 s ceiling. Disable the per-request
        // timeout for upload calls and rely on the browser network
        // layer to abort.
        timeout: 0,
        // ``signal`` is the standard AbortSignal — axios honours it via
        // the underlying transport, aborting the network request
        // immediately when ``controller.abort()`` is called. The bulk
        // upload dialog uses this so closing / cancelling mid-upload
        // stops the worker pool instead of silently pushing files in
        // the background.
        signal,
        onUploadProgress: onProgress
          ? (evt) => {
              const total =
                typeof evt.total === "number" && evt.total > 0
                  ? evt.total
                  : file.size;
              onProgress(evt.loaded ?? 0, total);
            }
          : undefined,
      })
    ).data;
  },
  uploadZip: async (
    taskId: string,
    file: File,
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<Asset[]> => {
    const fd = new FormData();
    fd.append("file", file);
    return (
      await api.post<Asset[]>(`/tasks/${taskId}/assets:zip`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 0,
        signal,
        onUploadProgress: onProgress
          ? (evt) => {
              const total =
                typeof evt.total === "number" && evt.total > 0
                  ? evt.total
                  : file.size;
              onProgress(evt.loaded ?? 0, total);
            }
          : undefined,
      })
    ).data;
  },
  get: async (assetId: string): Promise<AssetWithUrl> =>
    (await api.get<AssetWithUrl>(`/assets/${assetId}`)).data,
  delete: async (assetId: string): Promise<void> => {
    await api.delete(`/assets/${assetId}`);
  },
};
