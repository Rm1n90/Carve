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

export type YoloMode = "detection" | "segmentation" | "tags_only";

export interface ExportRequest {
  format: ExportFormat;
  class_remap: ClassRemap;
  splits: ExportSplits;
  include_images: boolean;
  /** Plan-20.1 — how mixed-kind annotations are rendered into the YOLO
   *  label files. Ignored when ``format === "coco"``. Server defaults
   *  to ``"segmentation"`` when omitted. */
  yolo_mode?: YoloMode;
}

export interface AnnotationKindCounts {
  bbox: number;
  polygon: number;
  mask: number;
  tag: number;
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
  /** Plan-20.1 — per-kind annotation counts for the current task,
   *  used by the YOLO chooser to detect mixed-kind exports. */
  kinds: async (taskId: string): Promise<AnnotationKindCounts> =>
    (await api.get<AnnotationKindCounts>(
      `/tasks/${taskId}/annotation-kinds`,
    )).data,
};
