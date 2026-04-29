import { api } from "./client";

export type TaskKind = "image" | "video";

export interface Task {
  id: string;
  project_id: string;
  name: string;
  kind: TaskKind;
  created_at: string;
}

export interface TaskIn {
  name: string;
  kind: TaskKind;
}

export const tasksApi = {
  listForProject: async (projectId: string): Promise<Task[]> =>
    (await api.get<Task[]>(`/projects/${projectId}/tasks`)).data,
  create: async (projectId: string, input: TaskIn): Promise<Task> =>
    (await api.post<Task>(`/projects/${projectId}/tasks`, input)).data,
  delete: async (projectId: string, taskId: string): Promise<void> => {
    await api.delete(`/projects/${projectId}/tasks/${taskId}`);
  },
  duplicate: async (
    projectId: string,
    taskId: string,
    count = 1,
    name?: string,
  ): Promise<Task[]> => {
    // v3.1 Bug 2 — when a custom name is provided, POST it as a JSON
    // body. The backend forces count=1 in that path; we keep the
    // ``count`` query param on the URL for back-compat with the
    // count-only callers (count is 1 by default).
    const url = `/projects/${projectId}/tasks/${taskId}/duplicate?count=${count}`;
    const body = name !== undefined ? { name } : undefined;
    return (await api.post<Task[]>(url, body)).data;
  },
};
