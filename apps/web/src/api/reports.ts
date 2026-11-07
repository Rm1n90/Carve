// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";

/** One person's annotations in one task (or class) of one project. */
export interface AnnotationCountRow {
  project_id: string;
  project_name: string;
  task_id: string | null;
  task_name: string | null;
  class_name: string | null;
  user_id: string | null;
  email: string | null;
  total: number;
  /** Made by an AI run they started (the annotation has a model score). */
  from_ai: number;
  /** Images or video frames with at least one of them. */
  images: number;
}

export interface AnnotationCounts {
  group_by: "task" | "class";
  since: string | null;
  rows: AnnotationCountRow[];
}

export interface AnnotationCountsFilter {
  project_id?: string;
  task_id?: string;
  group_by: "task" | "class";
  days?: number;
}

/** Superadmin reports (`/admin/reports`). */
export const reportsApi = {
  annotations: async (filter: AnnotationCountsFilter): Promise<AnnotationCounts> =>
    (await api.get<AnnotationCounts>("/admin/reports/annotations", { params: filter })).data,
};
