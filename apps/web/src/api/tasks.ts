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
  // Plan-21 — task completion. Both null means "in progress".
  completed_at?: string | null;
  completed_by?: string | null;
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
  // Plan-21 — completion toggle. ``true`` stamps completion fields,
  // ``false`` clears them. Omit to leave the completion state alone.
  completed?: boolean;
}

/**
 * Plan-21 — payload returned by ``GET .../tasks/{id}/completion-status``.
 * Drives the editor's "Task ready for completion" smart-suggestion
 * banner: render only when ``annotated_assets > 0 &&
 * annotated_assets === total_assets`` and the task is not yet completed.
 */
export interface TaskCompletionStatusResponse {
  total_assets: number;
  annotated_assets: number;
  /** 0..1 fraction of assets with at least one annotation. */
  percent: number;
}

/**
 * Per-user resume payload returned by
 * ``GET /projects/{pid}/tasks/{tid}/resume``. Drives the
 * <ResumeProgressBanner /> on AnnotateAssetPage.
 *
 * All four ``last_*`` fields are null together when the user has no
 * annotations in this task yet.
 */
export interface TaskResumeStatusResponse {
  last_asset_id: string | null;
  last_frame_id: string | null;
  annotated_assets: number;
  total_assets: number;
  last_activity_at: string | null;
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
  // Plan-21 — toggle a task between "completed" and "in progress".
  // Wrap the existing PATCH; the backend stamps/clears
  // ``completed_at`` and ``completed_by`` based on the boolean.
  markComplete: async (
    projectId: string,
    taskId: string,
    completed: boolean,
  ): Promise<Task> =>
    (
      await api.patch<Task>(`/projects/${projectId}/tasks/${taskId}`, {
        completed,
      })
    ).data,
  // Plan-21 — fetch how many of a task's assets have at least one
  // annotation. Used by the editor's smart-suggestion banner. The
  // response shape mirrors the Pydantic ``TaskCompletionStatus``.
  completionStatus: async (
    projectId: string,
    taskId: string,
  ): Promise<TaskCompletionStatusResponse> =>
    (
      await api.get<TaskCompletionStatusResponse>(
        `/projects/${projectId}/tasks/${taskId}/completion-status`,
      )
    ).data,
  // Per-user resume payload. Drives the editor's
  // <ResumeProgressBanner />. The response shape mirrors the
  // Pydantic ``TaskResumeStatus``.
  resumeStatus: async (
    projectId: string,
    taskId: string,
  ): Promise<TaskResumeStatusResponse> =>
    (
      await api.get<TaskResumeStatusResponse>(
        `/projects/${projectId}/tasks/${taskId}/resume`,
      )
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
