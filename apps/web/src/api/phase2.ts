import { api } from "./client";

// ----------------------------- /trash -----------------------------

export interface TrashItem {
  kind: "project" | "task";
  id: string;
  name: string;
  project_id: string | null;
  deleted_at: string;
}

export interface TrashList {
  items: TrashItem[];
}

export const trashApi = {
  list: async (): Promise<TrashList> =>
    (await api.get<TrashList>("/trash")).data,
  restore: async (kind: "project" | "task", id: string): Promise<void> => {
    await api.post(`/trash/${kind}/${id}/restore`);
  },
  hardDelete: async (kind: "project" | "task", id: string): Promise<void> => {
    await api.delete(`/trash/${kind}/${id}`);
  },
};

// ------------------------- /models/sam-active -------------------------

export interface SamActive {
  active: string;
  available: string[];
}

export const modelsApi = {
  samActive: async (): Promise<SamActive> =>
    (await api.get<SamActive>("/models/sam-active")).data,
};

// --------------------------- /weights (workspace) ---------------------------

export interface Weight {
  id: string;
  project_id: string;
  name: string;
  task_kind: "detect" | "segment" | "classify" | "pose";
  minio_key: string;
  size_bytes: number;
  class_names: string[];
  created_by: string | null;
  created_at: string;
}

export const weightsApi = {
  listWorkspace: async (): Promise<Weight[]> =>
    (await api.get<Weight[]>("/weights")).data,
  listForProject: async (projectId: string): Promise<Weight[]> =>
    (await api.get<Weight[]>(`/projects/${projectId}/weights`)).data,
};

// --------------------------- /assets/{aid}/auto-annotate ---------------------------

export interface YoloPredictResult {
  // Returns the array of created annotations (already persisted).
  // We re-fetch annotations after a predict to keep state consistent.
  count: number;
}

export const inferenceApi = {
  predictYolo: async (
    assetId: string,
    weightId: string,
    overwrite = false,
  ): Promise<YoloPredictResult> => {
    const url = `/assets/${assetId}/auto-annotate?weight_id=${encodeURIComponent(
      weightId,
    )}&overwrite=${overwrite ? "true" : "false"}`;
    const r = await api.post<unknown[]>(url);
    return { count: Array.isArray(r.data) ? r.data.length : 0 };
  },
};
