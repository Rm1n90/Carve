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
  /** True only when the model service is actually responding (health
   * probe from the API). When `reachable: false`, the UI shows the
   * SAM-unavailable banner regardless of `available.length`. */
  reachable?: boolean;
}

/** Response from POST /models/sam-active — the active variant after the
 * model service finished loading. */
export interface SamSwitchResult {
  active_variant: string;
}

export const modelsApi = {
  samActive: async (): Promise<SamActive> =>
    (await api.get<SamActive>("/models/sam-active")).data,
  /**
   * Hot-swap the active SAM variant. Blocks for the full model load
   * (5-30s typical). Throws on 422 (unknown variant) or 503
   * (model service unavailable).
   */
  samSetActive: async (variant: string): Promise<SamSwitchResult> =>
    (await api.post<SamSwitchResult>("/models/sam-active", { variant })).data,
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
  /**
   * v3.3 Issue 4 — true when this weight is the project default for its
   * `task_kind`. The backend enforces at most one default per
   * (project_id, task_kind) via a partial unique index.
   */
  is_default: boolean;
}

export interface UploadWeightInput {
  name: string;
  task_kind: "detect" | "segment" | "classify" | "pose";
  /** Class names extracted from the YOLO model. Backend can also auto-detect. */
  class_names: string[];
  file: File;
}

export const weightsApi = {
  listWorkspace: async (): Promise<Weight[]> =>
    (await api.get<Weight[]>("/weights")).data,
  listForProject: async (projectId: string): Promise<Weight[]> =>
    (await api.get<Weight[]>(`/projects/${projectId}/weights`)).data,
  upload: async (projectId: string, input: UploadWeightInput): Promise<Weight> => {
    const fd = new FormData();
    fd.append("name", input.name);
    fd.append("task_kind", input.task_kind);
    fd.append("class_names", JSON.stringify(input.class_names));
    fd.append("file", input.file);
    return (await api.post<Weight>(`/projects/${projectId}/weights`, fd, {
      headers: { "Content-Type": "multipart/form-data" },
    })).data;
  },
  /**
   * Update mutable fields on an existing weight. Currently only `name`
   * (per backend `PATCH /weights/{id}` schema). The on-disk file and
   * `task_kind` are immutable to avoid surprising inference behavior.
   */
  update: async (weightId: string, patch: { name: string }): Promise<Weight> =>
    (await api.patch<Weight>(`/weights/${weightId}`, patch)).data,
  delete: async (weightId: string): Promise<void> => {
    await api.delete(`/weights/${weightId}`);
  },
  /**
   * v3.3 Issue 4 — mark this weight as the default for its
   * `(project_id, task_kind)` slot. Admin-or-owner gated server-side.
   */
  setDefault: async (weightId: string): Promise<Weight> =>
    (await api.post<Weight>(`/weights/${weightId}/default`)).data,
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
    minConfidence = 0.0,
  ): Promise<YoloPredictResult> => {
    const params = new URLSearchParams({
      weight_id: weightId,
      overwrite: overwrite ? "true" : "false",
      min_confidence: String(minConfidence),
    });
    const url = `/assets/${assetId}/auto-annotate?${params.toString()}`;
    const r = await api.post<unknown[]>(url);
    return { count: Array.isArray(r.data) ? r.data.length : 0 };
  },
};
