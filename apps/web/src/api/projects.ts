import { api } from "./client";

export interface Project {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  created_at: string;
}

export interface ProjectIn {
  name: string;
  description?: string;
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
};
