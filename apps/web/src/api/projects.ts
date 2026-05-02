// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";

export interface Project {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  // v3.3 Issue 2 — backend resolves the owner's email via a JOIN to users
  // so the UI can render a friendly "Created by …" label. Nullable to
  // tolerate orphaned/missing owner rows.
  owner_email: string | null;
  created_at: string;
}

export interface ProjectIn {
  name: string;
  description?: string;
}

export interface ImportClassesResult {
  imported: number;
  skipped: number;
}

export const projectsApi = {
  list: async (): Promise<Project[]> => (await api.get<Project[]>("/projects")).data,
  get: async (id: string): Promise<Project> =>
    (await api.get<Project>(`/projects/${id}`)).data,
  create: async (input: ProjectIn): Promise<Project> =>
    (await api.post<Project>("/projects", input)).data,
  update: async (id: string, patch: Partial<ProjectIn>): Promise<Project> =>
    (await api.patch<Project>(`/projects/${id}`, patch)).data,
  delete: async (id: string): Promise<void> => {
    await api.delete(`/projects/${id}`);
  },
  importClasses: async (
    projectId: string,
    sourceProjectId: string,
  ): Promise<ImportClassesResult> =>
    (
      await api.post<ImportClassesResult>(
        `/projects/${projectId}/classes/import`,
        { source_project_id: sourceProjectId },
      )
    ).data,
};
