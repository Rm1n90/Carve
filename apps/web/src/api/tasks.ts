// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";
import type { ClassRow } from "./classes";

export type TaskKind = "image" | "video";

export interface Task {
  id: string;
  project_id: string;
  name: string;
  kind: TaskKind;
  created_at: string;
  // Plan-15 Track G — optional schedule + archive marker (ISO 8601).
  due_date?: string | null;
  archived_at?: string | null;
}

export interface TaskIn {
  name: string;
  kind: TaskKind;
  due_date?: string | null;
}

export interface TaskPatch {
  name?: string;
  // ``null`` clears the schedule. Omit the key to leave unchanged.
  due_date?: string | null;
  archived?: boolean;
}

export interface ListTasksOptions {
  includeArchived?: boolean;
  onlyArchived?: boolean;
}

export interface TaskClassesResponse {
  classes: ClassRow[];
  // v3.1 Issue 3 (Option A). ``null`` means "no override; use all
  // project classes". An empty array means "no classes for this task".
  // Otherwise it is the explicit subset.
  allowed_class_ids: string[] | null;
}

export const tasksApi = {
  listForProject: async (
    projectId: string,
    opts?: ListTasksOptions,
  ): Promise<Task[]> => {
    const params = new URLSearchParams();
    if (opts?.includeArchived) params.set("include_archived", "true");
    if (opts?.onlyArchived) params.set("only_archived", "true");
    const qs = params.toString();
    const url = qs
      ? `/projects/${projectId}/tasks?${qs}`
      : `/projects/${projectId}/tasks`;
    return (await api.get<Task[]>(url)).data;
  },
  create: async (projectId: string, input: TaskIn): Promise<Task> =>
    (await api.post<Task>(`/projects/${projectId}/tasks`, input)).data,
  update: async (
    projectId: string,
    taskId: string,
    patch: TaskPatch,
  ): Promise<Task> =>
    (
      await api.patch<Task>(
        `/projects/${projectId}/tasks/${taskId}`,
        patch,
      )
    ).data,
  archive: async (projectId: string, taskId: string): Promise<Task> =>
    (
      await api.patch<Task>(`/projects/${projectId}/tasks/${taskId}`, {
        archived: true,
      })
    ).data,
  unarchive: async (projectId: string, taskId: string): Promise<Task> =>
    (
      await api.patch<Task>(`/projects/${projectId}/tasks/${taskId}`, {
        archived: false,
      })
    ).data,
  delete: async (projectId: string, taskId: string): Promise<void> => {
    await api.delete(`/projects/${projectId}/tasks/${taskId}`);
  },
  duplicate: async (
    projectId: string,
    taskId: string,
    count = 1,
    name?: string,
    allowed_class_ids?: string[] | null,
  ): Promise<Task[]> => {
    // v3.1 Bug 2 — when a custom name is provided, POST it as a JSON
    // body. The backend forces count=1 in that path; we keep the
    // ``count`` query param on the URL for back-compat with the
    // count-only callers (count is 1 by default).
    //
    // v3.2 Issue 4 — ``allowed_class_ids`` (optional) overrides the
    // duplicate's class subset. ``undefined`` omits the field; ``null``
    // means "keep source's snapshot"; ``[]`` means "no classes"; a
    // populated list narrows the duplicate's subset. The backend
    // validates ids belong to the source project.
    const url = `/projects/${projectId}/tasks/${taskId}/duplicate?count=${count}`;
    const hasAnyField =
      name !== undefined || allowed_class_ids !== undefined;
    const body = hasAnyField
      ? {
          ...(name !== undefined ? { name } : {}),
          ...(allowed_class_ids !== undefined ? { allowed_class_ids } : {}),
        }
      : undefined;
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
