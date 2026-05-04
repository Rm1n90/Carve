// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";

export type ImportFormat = "yolo" | "coco";
export type ImportStatus =
  | "pending"
  | "running"
  | "completed"
  | "completed_with_warnings"
  | "failed";

export interface ImportProgress {
  status: ImportStatus;
  done: number;
  total: number;
  warnings: string[];
}

export interface ImportReport {
  total_parsed: number;
  importable: number;
  by_kind: Record<string, number>;
  matched_files: string[];
  unmatched_files: { file: string; rows: number }[];
  unknown_classes: { class: string; rows: number }[];
  class_names_resolved: string[];
  parse_warnings: string[];
}

export interface DryrunResponse {
  import_id: string;
  format: ImportFormat;
  status: "awaiting_confirmation";
  report: ImportReport;
}

export const importsApi = {
  /** Plan-20.5 — stage an import (one or many files) and return a
   *  validation report without writing annotations. */
  createDryrun: async (
    taskId: string,
    files: File[],
    format: ImportFormat,
  ): Promise<DryrunResponse> => {
    const fd = new FormData();
    for (const f of files) fd.append("files", f);
    return (
      await api.post<DryrunResponse>(
        `/tasks/${taskId}/imports?format=${format}&dryrun=true`,
        fd,
        { headers: { "Content-Type": "multipart/form-data" } },
      )
    ).data;
  },
  /** Plan-20.5 — commit a previously-staged dryrun import. */
  confirm: async (
    taskId: string,
    importId: string,
  ): Promise<{ import_id: string; status: string }> =>
    (
      await api.post<{ import_id: string; status: string }>(
        `/tasks/${taskId}/imports/${importId}/confirm`,
      )
    ).data,
  get: async (taskId: string, importId: string): Promise<ImportProgress> =>
    (await api.get<ImportProgress>(`/tasks/${taskId}/imports/${importId}`)).data,
};
