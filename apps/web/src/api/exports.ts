// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";

export type ExportFormat = "yolo" | "coco";
export type ExportStatus = "pending" | "running" | "completed" | "failed";

export interface ExportSplits {
  train: number;
  val: number;
  test: number;
}

export interface ClassRemapTarget {
  export_id: number;
  name: string;
}

// keyed by source class UUID; null = skip
export type ClassRemap = Record<string, ClassRemapTarget | null>;

export interface ExportRequest {
  format: ExportFormat;
  class_remap: ClassRemap;
  splits: ExportSplits;
  include_images: boolean;
}

export interface ExportProgress {
  id: string;
  status: ExportStatus;
  download_url: string | null;
  error: string | null;
  completed_at: string | null;
}

export const exportsApi = {
  create: async (
    taskId: string,
    body: ExportRequest,
  ): Promise<{ export_id: string }> =>
    (await api.post<{ export_id: string }>(`/tasks/${taskId}/exports`, body)).data,
  get: async (taskId: string, exportId: string): Promise<ExportProgress> =>
    (await api.get<ExportProgress>(`/tasks/${taskId}/exports/${exportId}`)).data,
};
