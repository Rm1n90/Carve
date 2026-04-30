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

export type WeightTaskKind = "detect" | "segment" | "classify" | "pose";

export interface Weight {
  id: string;
  /**
   * v3.5 Phase F5 — `null` for workspace-wide weights (visible from
   * every project); a project id for project-scoped weights.
   */
  project_id: string | null;
  name: string;
  task_kind: WeightTaskKind;
  minio_key: string;
  size_bytes: number;
  class_names: string[];
  created_by: string | null;
  created_at: string;
  /**
   * v3.5 Phase F5 — per-project default flag. Computed by the backend
   * against `weight_project_defaults` for the requesting project
   * context. `false` on the workspace listing (no project context).
   */
  is_default: boolean;
}

export interface UploadWeightInput {
  name: string;
  task_kind: WeightTaskKind;
  /** Class names extracted from the YOLO model. Backend can also auto-detect. */
  class_names: string[];
  file: File;
}

export const weightsApi = {
  listWorkspace: async (): Promise<Weight[]> =>
    (await api.get<Weight[]>("/weights")).data,
  listForProject: async (projectId: string): Promise<Weight[]> =>
    (await api.get<Weight[]>(`/projects/${projectId}/weights`)).data,
  /**
   * v3.5 Phase F5 — upload a workspace-wide weight (`project_id` is
   * null). The new default upload path; the legacy `upload(projectId,
   * ...)` form is preserved for project-scoped uploads.
   */
  uploadWorkspace: async (input: UploadWeightInput): Promise<Weight> => {
    const fd = new FormData();
    fd.append("name", input.name);
    fd.append("task_kind", input.task_kind);
    fd.append("class_names", JSON.stringify(input.class_names));
    fd.append("file", input.file);
    return (
      await api.post<Weight>("/weights", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      })
    ).data;
  },
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
   * v3.5 Phase F5 — pin a weight as the project's default for the
   * given `task_kind`. Writes to `weight_project_defaults`. The
   * weight's own `project_id` is unchanged (workspace weights stay
   * workspace-wide and can serve as defaults in many projects).
   */
  setDefault: async (
    weightId: string,
    body: { project_id: string; task_kind: WeightTaskKind },
  ): Promise<Weight> =>
    (await api.post<Weight>(`/weights/${weightId}/default`, body)).data,
  /**
   * v3.7 Phase 3 Issue 4 — many-to-many weight ↔ project assignments.
   * `getAssignments` lists assigned projects (with names) for the UI
   * details panel; `addAssignment` is idempotent server-side; `removeAssignment`
   * is also idempotent (a missing row still returns 204).
   */
  getAssignments: async (weightId: string): Promise<WeightAssignment[]> =>
    (
      await api.get<WeightAssignment[]>(`/weights/${weightId}/assignments`)
    ).data,
  addAssignment: async (
    weightId: string,
    projectId: string,
  ): Promise<WeightAssignment> =>
    (
      await api.post<WeightAssignment>(`/weights/${weightId}/assignments`, {
        project_id: projectId,
      })
    ).data,
  removeAssignment: async (weightId: string, projectId: string): Promise<void> => {
    await api.delete(`/weights/${weightId}/assignments/${projectId}`);
  },
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
};

/**
 * v3.7 Phase 3 Issue 4 — one row of the weight ↔ project membership
 * join. The backend joins `projects.name` so the chip list can render
 * a human-readable label without an extra round-trip.
 */
export interface WeightAssignment {
  weight_id: string;
  project_id: string;
  project_name: string;
  created_at: string;
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
  /** v3.7.2 — true when overwrite=true was requested but the predict
   * yielded zero annotations, so existing annotations were intentionally
   * preserved (data-loss prevention). UI surfaces a warning toast. */
  overwrite_skipped: boolean;
}

interface AutoAnnotateApiResponse {
  annotations: unknown[];
  annotations_created: number;
  skipped_count: number;
  skipped_by_class: Record<string, number>;
  overwrite_skipped?: boolean;
}

/**
 * v3.5 Phase F2 — predict-time class binding overrides. Keys are
 * weight-class indices (string-encoded for JSON safety); values are
 * project-class ids OR `null` to skip that weight class for this run.
 */
export type ClassOverrides = Record<string, string | null>;

/**
 * v3.7 Phase 2 Issue 1 — batch predict response. Returned synchronously
 * by ``POST /tasks/{taskId}/auto-annotate`` once the RQ job has been
 * enqueued. Callers poll progress via :func:`pollBatchProgress`.
 */
export interface BatchPredictResult {
  job_id: string;
}

/**
 * v3.7 Phase 2 Issue 1 — batch predict progress snapshot. Mirrors the
 * Redis hash written by the RQ worker (see ``apps/api/src/carve_api/inference/batch.py``).
 *
 *  - ``status``: pending | running | completed | completed_with_errors | failed
 *  - ``done``: assets processed successfully so far
 *  - ``total``: total asset count for the job (0 until init_progress fires)
 *  - ``failed``: count of asset-level failures
 *  - ``errors``: last 50 per-asset error strings ("<original_name>: <code>")
 */
export interface BatchPredictProgress {
  status:
    | "pending"
    | "running"
    | "completed"
    | "completed_with_errors"
    | "failed";
  done: number;
  total: number;
  failed: number;
  errors: string[];
  /** v3.7.2 — sum of annotations created across every asset in the
   * batch. Surfaces in the post-batch toast so the user knows whether
   * the predict actually produced anything. */
  total_annotations_created: number;
  /** v3.7.2 — sum of detections skipped (typically due to unmapped
   * weight classes) across every asset in the batch. */
  total_skipped_detections: number;
}

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
      overwrite_skipped:
        typeof data?.overwrite_skipped === "boolean"
          ? data.overwrite_skipped
          : false,
    };
  },
  /**
   * v3.7 Phase 2 Issue 1 — enqueue a batch predict over every asset in a
   * task. Returns ``{job_id}`` synchronously; the worker runs in RQ.
   * Poll :func:`pollBatchProgress` every ~1.5s until ``status`` is one
   * of ``completed | completed_with_errors | failed``.
   */
  predictYoloBatch: async (
    taskId: string,
    weightId: string,
    overwrite = false,
    minConfidence = 0.0,
    classOverrides?: ClassOverrides,
  ): Promise<BatchPredictResult> => {
    const params = new URLSearchParams({
      weight_id: weightId,
      overwrite: overwrite ? "true" : "false",
    });
    const url = `/tasks/${taskId}/auto-annotate?${params.toString()}`;
    const body: {
      min_confidence?: number;
      class_overrides?: ClassOverrides;
    } = {};
    if (Number.isFinite(minConfidence)) {
      body.min_confidence = Math.max(0, Math.min(1, minConfidence));
    }
    if (classOverrides && Object.keys(classOverrides).length > 0) {
      body.class_overrides = classOverrides;
    }
    const wireBody = Object.keys(body).length > 0 ? body : undefined;
    const r = await api.post<BatchPredictResult>(url, wireBody);
    return { job_id: r.data?.job_id ?? "" };
  },
  /**
   * v3.7 Phase 2 Issue 1 — read RQ-batch progress for the supplied
   * ``job_id``. Always returns a default ``"pending"`` snapshot when
   * the key is missing (e.g. Redis was momentarily unavailable when
   * the worker tried to ``init_progress``); the caller can keep
   * polling without crashing.
   */
  pollBatchProgress: async (
    taskId: string,
    jobId: string,
  ): Promise<BatchPredictProgress> => {
    const r = await api.get<BatchPredictProgress>(
      `/tasks/${taskId}/auto-annotate/${jobId}`,
    );
    const d = r.data;
    return {
      status: (d?.status ?? "pending") as BatchPredictProgress["status"],
      done: typeof d?.done === "number" ? d.done : 0,
      total: typeof d?.total === "number" ? d.total : 0,
      failed: typeof d?.failed === "number" ? d.failed : 0,
      errors: Array.isArray(d?.errors) ? d.errors : [],
      total_annotations_created:
        typeof d?.total_annotations_created === "number"
          ? d.total_annotations_created
          : 0,
      total_skipped_detections:
        typeof d?.total_skipped_detections === "number"
          ? d.total_skipped_detections
          : 0,
    };
  },
};
