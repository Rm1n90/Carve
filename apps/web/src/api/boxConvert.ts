// Armin Mehri — mehri.armin@gmail.com
//
// Task-wide box -> polygon / mask conversion, run on the server (one
// job per task; it survives reloads and closed tabs).
import { api } from "./client";

export interface BoxConvertImage {
  index: number;
  asset_id: string;
  name: string;
  boxes?: number;
  polygons?: number;
  masks?: number;
  merged?: number;
  kept?: number;
  low_score?: number;
  error?: string;
  /** Seconds the image took. */
  s?: number;
}

export interface BoxConvertJob {
  job_id: string;
  task_id: string | null;
  status: "queued" | "running" | "waiting_for_gpu" | "completed" | "completed_with_errors" | "failed" | "canceled" | string;
  /** Images gone through, of all the task's images. */
  done: number;
  total: number;
  failed: number;
  errors: string[];
  error: string | null;
  boxes: number;
  polygons: number;
  masks: number;
  merged: number;
  kept: number;
  low_score: number;
  images_with_boxes: number;
  started_at: number | null;
  updated_at: number | null;
  current: { index: number; asset_id: string; name: string } | null;
  /** Newest first. */
  recent: BoxConvertImage[];
  seconds_per_image: number | null;
  eta_seconds: number | null;
  /** Says it runs, but no image finished for a long while. */
  stalled: boolean;
}

export interface BoxConvertState {
  job: BoxConvertJob | null;
  /** What is still a box in the task; not counted while a run goes. */
  left: { boxes: number; images: number } | null;
}

export const ACTIVE_STATUSES = new Set(["queued", "running", "waiting_for_gpu"]);

export const boxConvertApi = {
  get: async (taskId: string, recent = 24): Promise<BoxConvertState> =>
    (await api.get<BoxConvertState>(`/tasks/${taskId}/sam/box-convert`, { params: { recent } })).data,
  start: async (taskId: string): Promise<BoxConvertJob> =>
    (await api.post<{ job: BoxConvertJob }>(`/tasks/${taskId}/sam/box-convert`, {})).data.job,
  cancel: async (taskId: string, jobId: string): Promise<void> => {
    await api.post(`/tasks/${taskId}/sam/box-convert/${jobId}/cancel`);
  },
  resume: async (taskId: string, jobId: string): Promise<BoxConvertJob> =>
    (await api.post<{ job: BoxConvertJob }>(`/tasks/${taskId}/sam/box-convert/${jobId}/resume`)).data.job,
  log: async (
    taskId: string,
    jobId: string,
    { only = "all", offset = 0, limit = 60 }: { only?: "all" | "flagged" | "errors"; offset?: number; limit?: number } = {},
  ): Promise<{ total: number; items: BoxConvertImage[] }> =>
    (await api.get(`/tasks/${taskId}/sam/box-convert/${jobId}/log`, { params: { only, offset, limit } })).data,
  /** The image with its annotations drawn on it, as an object URL the
   *  caller revokes. */
  previewUrl: async (taskId: string, assetId: string, width: number): Promise<string> => {
    const r = await api.get<Blob>(`/tasks/${taskId}/assets/${assetId}/shapes-preview`, {
      params: { w: width },
      responseType: "blob",
    });
    return URL.createObjectURL(r.data);
  },
};
