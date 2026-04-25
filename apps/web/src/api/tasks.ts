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
};
