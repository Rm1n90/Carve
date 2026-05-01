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
  created_at: string;
}

export interface ClassIn {
  idx: number;
  name: string;
  color: string;
  attributes?: Record<string, unknown>;
  // v3.8 Phase 3 — optional. Omitted on create => null (ineligible).
  text_prompt?: string | null;
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
  delete: async (projectId: string, classId: string): Promise<void> => {
    await api.delete(`/projects/${projectId}/classes/${classId}`);
  },
};
