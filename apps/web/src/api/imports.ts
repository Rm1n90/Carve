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

export const importsApi = {
  create: async (
    taskId: string,
    file: File,
    format: ImportFormat,
  ): Promise<{ import_id: string }> => {
    const fd = new FormData();
    fd.append("file", file);
    return (
      await api.post<{ import_id: string }>(
        `/tasks/${taskId}/imports?format=${format}`,
        fd,
        { headers: { "Content-Type": "multipart/form-data" } },
      )
    ).data;
  },
  get: async (taskId: string, importId: string): Promise<ImportProgress> =>
    (await api.get<ImportProgress>(`/tasks/${taskId}/imports/${importId}`)).data,
};
