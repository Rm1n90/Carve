// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";
import type {
  AnnotationDraft,
  AnnotationKind,
  Geometry,
  ReviewStatus,
} from "@/state/annotations";

interface AnnotationOut {
  id: string;
  task_id: string;
  frame_id: string | null;
  class_id: string;
  kind: AnnotationKind;
  geometry: Record<string, unknown>;
  track_id: string | null;
  z_order?: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /**
   * Plan-09 Phase 5 Task 3 — server-authoritative review state. Optional
   * to keep older API responses (which omit the fields) compatible.
   */
  status?: ReviewStatus;
  reviewed_by_id?: string | null;
  reviewed_at?: string | null;
  prev_geometry?: Record<string, unknown> | null;
}

export interface BatchReviewOut {
  reviewed: string[];
  skipped: string[];
}

export type ReviewDecision = "accept" | "reject";

interface BatchOut {
  created: AnnotationOut[];
  updated: AnnotationOut[];
  deleted: string[];
  /**
   * Parallel to ``created`` — server echoes the client-supplied temp_id
   * (or null when omitted). Lets the client correlate server IDs to
   * draft state without iteration order. Audit bug M.
   *
   * Optional in the type so older API responses (which omit the field)
   * fall through to the legacy correlation path.
   */
  created_temp_ids?: (string | null)[];
}

interface AnnotationIn {
  frame_id: string | null;
  class_id: string;
  kind: AnnotationKind;
  geometry: Record<string, unknown>;
  track_id: string | null;
  z_order?: number;
  /**
   * Optional client-supplied identifier echoed back in the batch
   * response under ``created_temp_ids``. See audit bug M.
   */
  temp_id?: string | null;
}

interface BatchUpdateIn {
  id: string;
  // Plan-17 — kind may now change on update so the right-click
  // "Convert" submenu can flip a polygon annotation into a bbox
  // (and vice versa) without re-creation. The server validates
  // geometry against the new kind when both are sent.
  kind?: AnnotationKind;
  geometry?: Record<string, unknown>;
  class_id?: string;
  track_id?: string;
  z_order?: number;
}

export interface BatchPayload {
  create: AnnotationIn[];
  update: BatchUpdateIn[];
  delete: string[];
}

export function toDraft(server: AnnotationOut): AnnotationDraft {
  return {
    tempId: server.id,
    classId: server.class_id,
    kind: server.kind,
    geometry: server.geometry as unknown as Geometry,
    frameId: server.frame_id,
    serverId: server.id,
    dirty: false,
    zOrder: typeof server.z_order === "number" ? server.z_order : 0,
    // Plan-09 Phase 5 Task 3 — review lifecycle. Default missing server
    // fields to ``proposed`` / null so the UI can render review affordances
    // even against older API responses that omit them.
    status: server.status ?? "proposed",
    reviewedById: server.reviewed_by_id ?? null,
    reviewedAt: server.reviewed_at ?? null,
    prevGeometry: server.prev_geometry ?? null,
  };
}

export const annotationsApi = {
  listForTask: async (taskId: string, frameId?: string): Promise<AnnotationDraft[]> => {
    const url = frameId
      ? `/tasks/${taskId}/annotations?frame_id=${frameId}`
      : `/tasks/${taskId}/annotations`;
    const r = await api.get<AnnotationOut[]>(url);
    return r.data.map(toDraft);
  },
  batch: async (taskId: string, payload: BatchPayload): Promise<BatchOut> =>
    (await api.post<BatchOut>(`/tasks/${taskId}/annotations:batch`, payload)).data,
  /**
   * Plan-09 Phase 5 Task 3 — single-annotation review. Returns the
   * updated server-authoritative ``AnnotationOut`` (mapped through
   * ``toDraft`` so callers can apply the result directly to the store
   * via ``setReviewState``).
   */
  review: async (
    id: string,
    decision: ReviewDecision,
    note?: string,
  ): Promise<AnnotationDraft> => {
    const body: { decision: ReviewDecision; note?: string } = { decision };
    if (note !== undefined) body.note = note;
    const r = await api.post<AnnotationOut>(`/annotations/${id}/review`, body);
    return toDraft(r.data);
  },
  /** Plan-09 Phase 5 Task 3 — bulk review (e.g. "accept all proposed"). */
  batchReview: async (
    ids: string[],
    decision: ReviewDecision,
    note?: string,
  ): Promise<BatchReviewOut> => {
    const body: { ids: string[]; decision: ReviewDecision; note?: string } = {
      ids,
      decision,
    };
    if (note !== undefined) body.note = note;
    const r = await api.post<BatchReviewOut>(`/annotations/batch:review`, body);
    return r.data;
  },
};
