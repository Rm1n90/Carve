// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";

export interface ClassRow {
  id: string;
  project_id: string;
  idx: number;
  name: string;
  color: string;
  attributes: Record<string, unknown>;
  // v3.8 Phase 3 — per-class SAM 3 text concept. null/undefined = not
  // eligible for Text-SAM (runner UI hides such classes). Optional so
  // legacy test fixtures (and any pre-Phase-3 cached responses) keep
  // type-checking; the server always sends it post-Phase-3.
  text_prompt?: string | null;
  // v3.31 — IS-A parent ("Racing Car" parent = "Car"). null/undefined =
  // top-level class. Auto-annotate's cross-class NMS resolver drops the
  // ancestor when it overlaps a descendant above the configured IoU
  // floor. Optional so older cached responses keep type-checking.
  parent_class_id?: string | null;
  created_at: string;
}

export interface ClassIn {
  idx: number;
  name: string;
  color: string;
  attributes?: Record<string, unknown>;
  // v3.8 Phase 3 — optional. Omitted on create => null (ineligible).
  text_prompt?: string | null;
  // v3.31 — see ClassRow.parent_class_id. Omitted on create => null
  // (top-level class). Pass null explicitly to clear an existing parent
  // via the PATCH endpoint; omit to leave unchanged.
  parent_class_id?: string | null;
}

export const classesApi = {
  listForProject: async (projectId: string): Promise<ClassRow[]> =>
    (await api.get<ClassRow[]>(`/projects/${projectId}/classes`)).data,
  create: async (projectId: string, input: ClassIn): Promise<ClassRow> =>
    (await api.post<ClassRow>(`/projects/${projectId}/classes`, input)).data,
  update: async (
    projectId: string,
    classId: string,
    patch: Partial<ClassIn>,
  ): Promise<ClassRow> =>
    (await api.patch<ClassRow>(`/projects/${projectId}/classes/${classId}`, patch)).data,
  // `force` opts into the irreversible cascade that also deletes every
  // annotation using this class. Without it, the server refuses a
  // non-empty class with 409 `class_has_annotations` and returns the
  // annotation count so the caller can warn the user first.
  delete: async (
    projectId: string,
    classId: string,
    opts?: { force?: boolean },
  ): Promise<void> => {
    await api.delete(`/projects/${projectId}/classes/${classId}`, {
      params: opts?.force ? { force: true } : undefined,
    });
  },
};
