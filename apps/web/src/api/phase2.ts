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

/** Response from POST /models/sam-active.
 *
 * v3.5 Phase C — the endpoint is now non-blocking. ``active_variant`` is
 * preserved as an alias for ``variant`` so legacy callers keep working.
 * The frontend polls ``GET /models/sam-status`` to learn when the load
 * actually completes. */
export interface SamSwitchResult {
  job_id: string;
  state: SamLoadStateKind;
  variant: string;
  /** Alias of ``variant``. Kept for backward compat. */
  active_variant: string;
}

/** Load-state machine kinds returned by ``GET /models/sam-status``. */
export type SamLoadStateKind = "idle" | "loading" | "ready" | "error";

/** Response from GET /models/sam-status.
 *
 * v3.5 Phase C — surfaces the predictor's load lifecycle so the editor
 * can show a "Loading SAM…" overlay during the 5-30s HF weight
 * download / build. Polled every ~1.5s while the overlay is open. */
export interface SamLoadStatus {
  state: SamLoadStateKind;
  variant: string | null;
  /** Bytes downloaded so far. Null when HF doesn't expose progress. */
  progress_bytes: number | null;
  /** Total bytes expected. Null when HF doesn't expose progress. */
  progress_total: number | null;
  /** ISO8601 timestamp of the last successful load (state="ready"). */
  loaded_at: string | null;
  /** Error detail when state="error". */
  error: string | null;
  /** Correlation token from the most recent switch, if any. */
  job_id?: string | null;
}

export const modelsApi = {
  samActive: async (): Promise<SamActive> =>
    (await api.get<SamActive>("/models/sam-active")).data,
  /**
   * Hot-swap the active SAM variant (non-blocking).
   *
   * Returns 202 + ``{job_id, state, variant}`` immediately. The model
   * service performs the actual 5-30s load in the background; the
   * frontend polls ``samStatus()`` until state transitions to ``ready``
   * (or ``error``). Throws on 422 (unknown variant), 409
   * (switch_in_progress), or 503 (model service unavailable).
   */
  samSetActive: async (variant: string): Promise<SamSwitchResult> =>
    (await api.post<SamSwitchResult>("/models/sam-active", { variant })).data,
  /**
   * Read the SAM predictor's current load state.
   *
   * Use with TanStack Query's ``refetchInterval`` to drive a loading
   * overlay (see ``ModelLoadingOverlay``). Returns a synthetic
   * ``state="error"`` with ``error="model_service_unreachable"`` when
   * the model container is unreachable so the overlay can dismiss
   * cleanly instead of spinning.
   */
  samStatus: async (): Promise<SamLoadStatus> =>
    (await api.get<SamLoadStatus>("/models/sam-status")).data,
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
  /**
   * v3.5 Phase F1 — read-only predict-time mapping suggestions for a
   * `(weight, task)` pair. Returns one entry per weight class with a
   * suggested project class id (case-insensitive name match) and the
   * full list of alternatives the predict popover lets the user pick
   * from. Replaces the v3.3 persistent `weight_class_mappings` table.
   */
  getMappingSuggestions: async (
    weightId: string,
    taskId: string,
  ): Promise<MappingSuggestionsResponse> =>
    (
      await api.get<MappingSuggestionsResponse>(
        `/weights/${weightId}/mapping-suggestions?task_id=${encodeURIComponent(taskId)}`,
      )
    ).data,
  /**
   * v3.3 Issue 3c — list every weight-class → project-class mapping row
   * for a weight. Returned in `weight_class_idx` order.
   *
   * @deprecated Phase F4 removes this — the persistent mapping table is
   * dropped and replaced with the transient `getMappingSuggestions` API.
   */
  getMappings: async (weightId: string): Promise<WeightClassMapping[]> =>
    (await api.get<WeightClassMapping[]>(`/weights/${weightId}/mappings`)).data,
  /**
   * v3.3 Issue 3c — update a single mapping row's `project_class_id`.
   *
   * @deprecated Phase F4 removes this. Use `class_overrides` on the
   * predict body via `inferenceApi.predictYolo`.
   */
  updateMapping: async (
    weightId: string,
    mappingId: string,
    patch: { project_class_id: string | null },
  ): Promise<WeightClassMapping> =>
    (
      await api.put<WeightClassMapping>(
        `/weights/${weightId}/mappings/${mappingId}`,
        patch,
      )
    ).data,
};

/**
 * v3.3 Issue 3c — single mapping row exposed by
 * `GET /weights/{wid}/mappings`. `project_class_id` is null when the
 * weight class doesn't (yet) bind to a project class.
 *
 * @deprecated Phase F4 removes this — see `MappingSuggestion` instead.
 */
export interface WeightClassMapping {
  id: string;
  weight_id: string;
  weight_class_idx: number;
  weight_class_name: string;
  project_class_id: string | null;
}

/**
 * v3.5 Phase F1 — single mapping suggestion for a `(weight, task)` pair.
 * Computed on the fly by `GET /weights/{wid}/mapping-suggestions?task_id=…`.
 * `suggested_project_class_id` is null when no project class shares the
 * weight class's name. `alternatives` lists every project class the user
 * can pick from in the predict popover.
 */
export interface MappingSuggestionAlternative {
  id: string;
  name: string;
}

export interface MappingSuggestion {
  weight_class_idx: number;
  weight_class_name: string;
  suggested_project_class_id: string | null;
  alternatives: MappingSuggestionAlternative[];
}

export interface MappingSuggestionsResponse {
  suggestions: MappingSuggestion[];
}

// --------------------------- /assets/{aid}/auto-annotate ---------------------------

/**
 * v3.3 Issue 3c — predict response now includes a per-class skipped tally
 * so the editor can surface "Created N · skipped M (unmapped: …)" instead
 * of the old silent-drop. `count` is preserved as a convenience alias for
 * `annotations_created` so legacy call sites keep working.
 */
export interface YoloPredictResult {
  count: number;
  annotations_created: number;
  skipped_count: number;
  skipped_by_class: Record<string, number>;
}

interface AutoAnnotateApiResponse {
  annotations: unknown[];
  annotations_created: number;
  skipped_count: number;
  skipped_by_class: Record<string, number>;
}

/**
 * v3.5 Phase F2 — predict-time class binding overrides. Keys are
 * weight-class indices (string-encoded for JSON safety); values are
 * project-class ids OR `null` to skip that weight class for this run.
 */
export type ClassOverrides = Record<string, string | null>;

export const inferenceApi = {
  predictYolo: async (
    assetId: string,
    weightId: string,
    overwrite = false,
    minConfidence = 0.0,
    classOverrides?: ClassOverrides,
  ): Promise<YoloPredictResult> => {
    const params = new URLSearchParams({
      weight_id: weightId,
      overwrite: overwrite ? "true" : "false",
      min_confidence: String(minConfidence),
    });
    const url = `/assets/${assetId}/auto-annotate?${params.toString()}`;
    // The body is optional. When the popover passes overrides we POST a
    // JSON body; otherwise the legacy POST-no-body shape keeps working.
    const body =
      classOverrides && Object.keys(classOverrides).length > 0
        ? { class_overrides: classOverrides }
        : undefined;
    const r = await api.post<AutoAnnotateApiResponse>(url, body);
    const data = r.data;
    const created =
      typeof data?.annotations_created === "number"
        ? data.annotations_created
        : Array.isArray(data?.annotations)
          ? data.annotations.length
          : 0;
    return {
      count: created,
      annotations_created: created,
      skipped_count:
        typeof data?.skipped_count === "number" ? data.skipped_count : 0,
      skipped_by_class:
        data?.skipped_by_class && typeof data.skipped_by_class === "object"
          ? data.skipped_by_class
          : {},
    };
  },
};
