import { api } from "./client";
import type { AnnotationDraft, AnnotationKind, Geometry } from "@/state/annotations";

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
}

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
};
