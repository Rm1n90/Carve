// Armin Mehri — mehri.armin@gmail.com
/**
 * YOLOE — Real-Time Seeing Anything (v3.23).
 *
 * Three sync per-asset modes (text / visual / prompt-free), one batch
 * enqueue + poll + cancel set, plus a capability probe. Mirrors the
 * shape of ``samApi`` and ``inferenceApi`` so the editor's existing
 * progress + cancel scaffolding works for YOLOE without bespoke code.
 */
import { api } from "./client";

/** Subset of the server's AnnotationOut shape we care about in the
 *  YOLOE dialog flow. Kept local so we don't have to widen the export
 *  surface of ``api/annotations.ts`` for one consumer. */
interface YoloeAnnotationOut {
  id: string;
  task_id: string;
  frame_id: string | null;
  class_id: string;
  kind: string;
  geometry: Record<string, unknown>;
  created_at: string;
}

export type YoloeMode = "text" | "visual" | "prompt_free";
export type YoloeOutputKind = "bbox" | "polygon";

export interface YoloeStatus {
  available: boolean;
  text_available: boolean;
  pf_available: boolean;
  text_loaded: boolean;
  pf_loaded: boolean;
  device: string;
}

export interface YoloeAutoAnnotateResponse {
  annotations: YoloeAnnotationOut[];
  annotations_created: number;
  skipped_count: number;
  skipped_by_class: Record<string, number>;
  overwrite_skipped: boolean;
}

export interface YoloeTextPromptItem {
  class_id: string;
  prompt: string;
}

export interface YoloeTextRequest {
  /** One row per (project class, prompt) pair. Multi-row lets the
   *  user target several project classes in a single forward pass —
   *  each detection is mapped back to its source class_id. */
  prompts: YoloeTextPromptItem[];
  conf?: number;
  iou?: number;
  overwrite?: boolean;
  frame_id?: string | null;
  /** "bbox" (default) saves bounding boxes; "polygon" saves instance
   *  masks. YOLOE-seg returns both per detection; we keep one to
   *  avoid stacked-duplicate annotations. */
  output_kind?: YoloeOutputKind;
  /** v3.31 — cross-class hierarchical NMS; see YoloeBatchRequest. */
  resolve_hierarchy?: boolean;
  hierarchy_iou?: number;
}

export interface YoloeVisualGroupItem {
  /** Project class to attach every match found for this group. */
  class_id: string;
  /** xyxy bboxes inside the source image's coordinate space. */
  bboxes: [number, number, number, number][];
}

export interface YoloeVisualSource {
  /** Source asset whose bytes serve as the YOLOE reference image. */
  asset_id: string;
  /** Class-keyed bbox groups inside this source. */
  groups: YoloeVisualGroupItem[];
}

export interface YoloeVisualRequest {
  /** v3.24 — list of source assets, each with its own class-keyed
   *  bbox groups. The api fetches each source's bytes from MinIO and
   *  runs YOLOE per (source, target) pair, then NMS-merges per-target
   *  detections to dedupe overlap from multiple sources. */
  sources: YoloeVisualSource[];
  conf?: number;
  iou?: number;
  overwrite?: boolean;
  frame_id?: string | null;
  output_kind?: YoloeOutputKind;
  /** v3.31 — cross-class hierarchical NMS; see YoloeBatchRequest. */
  resolve_hierarchy?: boolean;
  hierarchy_iou?: number;
}

export interface YoloePromptFreeRequest {
  annotate_as_class_id?: string | null;
  conf?: number;
  iou?: number;
  max_detections?: number | null;
  overwrite?: boolean;
  frame_id?: string | null;
  output_kind?: YoloeOutputKind;
  /** v3.31 — cross-class hierarchical NMS; see YoloeBatchRequest. */
  resolve_hierarchy?: boolean;
  hierarchy_iou?: number;
}

export interface YoloeBatchRequest {
  mode: YoloeMode;
  /** Mode-specific params; see api/inference/router.YoloeBatchIn. */
  params: Record<string, unknown>;
  overwrite?: boolean;
  output_kind?: YoloeOutputKind;
  /** v3.31 — optional subset filter from the "Range: from N to M"
   *  scope picker. UUIDs resolved client-side against the task's
   *  asset list. Omitted = run on every asset. */
  asset_ids?: string[];
  /** v3.31 — cross-class hierarchical NMS. Drops the more general
   *  (ancestor) class's annotation when it overlaps a more specific
   *  (descendant) class's annotation above ``hierarchy_iou``. */
  resolve_hierarchy?: boolean;
  hierarchy_iou?: number;
}

export interface YoloeBatchProgress {
  status:
    | "pending"
    | "running"
    | "waiting_for_gpu"
    | "completed"
    | "completed_with_errors"
    | "failed"
    | "canceled";
  done: number;
  total: number;
  failed: number;
  errors: string[];
  total_annotations_created: number;
  total_skipped_detections: number;
  skipped_by_class: Record<string, number>;
}

export const yoloeApi = {
  /** Capability probe — never throws; returns ``available: false`` on
   *  any error so the editor can hide UI without surfacing the error. */
  status: async (): Promise<YoloeStatus> => {
    try {
      const r = await api.get<YoloeStatus>("/inference/yoloe/status");
      return r.data;
    } catch {
      return {
        available: false,
        text_available: false,
        pf_available: false,
        text_loaded: false,
        pf_loaded: false,
        device: "unknown",
      };
    }
  },

  textPredict: async (
    assetId: string,
    body: YoloeTextRequest,
  ): Promise<YoloeAutoAnnotateResponse> =>
    (
      await api.post<YoloeAutoAnnotateResponse>(
        `/assets/${assetId}/yoloe/text`,
        body,
      )
    ).data,

  visualPredict: async (
    assetId: string,
    body: YoloeVisualRequest,
  ): Promise<YoloeAutoAnnotateResponse> =>
    (
      await api.post<YoloeAutoAnnotateResponse>(
        `/assets/${assetId}/yoloe/visual`,
        body,
      )
    ).data,

  promptFreePredict: async (
    assetId: string,
    body: YoloePromptFreeRequest,
  ): Promise<YoloeAutoAnnotateResponse> =>
    (
      await api.post<YoloeAutoAnnotateResponse>(
        `/assets/${assetId}/yoloe/prompt-free`,
        body,
      )
    ).data,

  enqueueBatch: async (
    taskId: string,
    body: YoloeBatchRequest,
  ): Promise<{ job_id: string }> =>
    (
      await api.post<{ job_id: string }>(
        `/tasks/${taskId}/yoloe/batch`,
        body,
      )
    ).data,

  pollBatch: async (
    taskId: string,
    jobId: string,
  ): Promise<YoloeBatchProgress> =>
    (
      await api.get<YoloeBatchProgress>(
        `/tasks/${taskId}/yoloe/batch/${jobId}`,
      )
    ).data,

  cancelBatch: async (
    taskId: string,
    jobId: string,
  ): Promise<{ job_id: string; status: string }> =>
    (
      await api.post<{ job_id: string; status: string }>(
        `/tasks/${taskId}/yoloe/batch/${jobId}/cancel`,
      )
    ).data,
};
