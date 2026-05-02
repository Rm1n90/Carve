// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";

export type DatasetKind =
  | "retrain"
  | "export"
  | "manual"
  | "rollback_pre"
  | "rollback_post";

export interface DatasetSummary {
  annotations?: number;
  accepted?: number;
  rejected?: number;
  classes?: string[];
  asset_count?: number;
  by_class?: Record<string, number>;
  [key: string]: unknown;
}

export interface DatasetVersionRow {
  id: string;
  project_id: string;
  task_id: string;
  kind: DatasetKind | string;
  source: string | null;
  created_by: string | null;
  created_at: string;
  label: string;
  frozen: boolean;
  summary: DatasetSummary | null;
  blob_key: string | null;
}

export interface DatasetVersionDetail extends DatasetVersionRow {
  download_url: string | null;
}

export interface DatasetDiffByImage {
  image: string;
  added: number;
  removed: number;
  changed: number;
}

export interface DatasetDiff {
  a_id: string;
  b_id: string;
  added: Record<string, number>;
  removed: Record<string, number>;
  changed: Record<string, number>;
  by_image: DatasetDiffByImage[];
  summary_a: DatasetSummary;
  summary_b: DatasetSummary;
  note: string | null;
}

export interface RollbackResult {
  pre_version_id: string;
  post_version_id: string;
  replaced_count: number;
  restored_count: number;
}

export interface DatasetListParams {
  kind?: DatasetKind;
  task_id?: string;
  before?: string;
  limit?: number;
}

export interface DatasetListPage {
  items: DatasetVersionRow[];
  next_cursor: string | null;
}

export const datasetsApi = {
  /**
   * The backend currently returns a bare list. We wrap it into a
   * ``{items, next_cursor}`` envelope so the frontend has one shape
   * to render and so a future cursor-paginated rollout is a no-op
   * for callers.
   */
  list: async (
    projectId: string,
    params: DatasetListParams = {},
  ): Promise<DatasetListPage> => {
    const query: Record<string, string | number> = {};
    if (params.kind) query.kind = params.kind;
    if (params.task_id) query.task_id = params.task_id;
    if (params.before) query.before = params.before;
    if (params.limit) query.limit = params.limit;
    const res = await api.get<DatasetVersionRow[]>(
      `/projects/${projectId}/datasets`,
      { params: query },
    );
    return { items: res.data, next_cursor: null };
  },
  get: async (
    projectId: string,
    versionId: string,
  ): Promise<DatasetVersionDetail> =>
    (
      await api.get<DatasetVersionDetail>(
        `/projects/${projectId}/datasets/${versionId}`,
      )
    ).data,
  diff: async (
    projectId: string,
    a: string,
    b: string,
  ): Promise<DatasetDiff> =>
    (
      await api.get<DatasetDiff>(
        `/projects/${projectId}/datasets/${a}/diff/${b}`,
      )
    ).data,
  rollback: async (
    projectId: string,
    versionId: string,
    taskId: string,
  ): Promise<RollbackResult> =>
    (
      await api.post<RollbackResult>(
        `/projects/${projectId}/datasets/${versionId}/rollback`,
        { task_id: taskId },
      )
    ).data,
};
