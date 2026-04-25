import { api } from "./client";

export interface ClassRow {
  id: string;
  project_id: string;
  idx: number;
  name: string;
  color: string;
  attributes: Record<string, unknown>;
  created_at: string;
}

export interface ClassIn {
  idx: number;
  name: string;
  color: string;
  attributes?: Record<string, unknown>;
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
