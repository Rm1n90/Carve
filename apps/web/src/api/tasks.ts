import { api } from "./client";
import type { ClassRow } from "./classes";

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

export interface TaskClassesResponse {
  classes: ClassRow[];
  // v3.1 Issue 3 (Option A). ``null`` means "no override; use all
  // project classes". An empty array means "no classes for this task".
  // Otherwise it is the explicit subset.
  allowed_class_ids: string[] | null;
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
  // v3.1 Issue 3 — task-effective classes (Option A subset model).
  getClasses: async (
    projectId: string,
    taskId: string,
  ): Promise<TaskClassesResponse> =>
    (
      await api.get<TaskClassesResponse>(
        `/projects/${projectId}/tasks/${taskId}/classes`,
      )
    ).data,
  setClasses: async (
    projectId: string,
    taskId: string,
    allowed_class_ids: string[] | null,
  ): Promise<TaskClassesResponse> =>
    (
      await api.put<TaskClassesResponse>(
        `/projects/${projectId}/tasks/${taskId}/classes`,
        { allowed_class_ids },
      )
    ).data,
};
