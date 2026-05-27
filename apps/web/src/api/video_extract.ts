// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";

export type ExtractMode = "auto" | "all" | "every_nth" | "count";
export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface BatchEnqueueIn {
  source_asset_ids: string[];
  mode: ExtractMode;
  n_or_k: number;
  quality: number;
}

export interface BatchJobItem {
  job_id: string;
  source_asset_id: string;
  source_filename: string;
  status: JobStatus;
  progress: number;
  frames_extracted: number;
  dedup_skipped: number;
  error_message: string | null;
}

export interface BatchEnvelope {
  batch_id: string;
  jobs: BatchJobItem[];
}

export const videoExtractApi = {
  enqueueBatch: async (
    projectId: string,
    taskId: string,
    body: BatchEnqueueIn,
  ): Promise<BatchEnvelope> =>
    (
      await api.post<BatchEnvelope>(
        `/projects/${projectId}/tasks/${taskId}/video-extract/batch`,
        body,
      )
    ).data,
  getBatchStatus: async (
    projectId: string,
    taskId: string,
    batchId: string,
  ): Promise<BatchEnvelope> =>
    (
      await api.get<BatchEnvelope>(
        `/projects/${projectId}/tasks/${taskId}/video-extract/batch/${batchId}`,
      )
    ).data,
  cancelBatch: async (
    projectId: string,
    taskId: string,
    batchId: string,
  ): Promise<void> => {
    await api.post(
      `/projects/${projectId}/tasks/${taskId}/video-extract/batch/${batchId}/cancel`,
    );
  },
};
