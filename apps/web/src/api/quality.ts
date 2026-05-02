// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";

export interface ReviewerQualityRow {
  reviewer_id: string;
  email: string;
  total_reviewed: number;
  accepted: number;
  rejected: number;
  accept_rate: number;
}

export interface RetrainRow {
  weight_id: string;
  created_at: string;
  metrics: Record<string, number>;
  epochs: number | null;
  imgsz: number | null;
}

export interface PerClassQualityRow {
  class_id: string;
  name: string;
  color: string;
  proposed: number;
  accepted: number;
  rejected: number;
  proxy_precision: number | null;
}

export interface QualityRangeParams {
  /** ISO-8601 timestamp (inclusive). */
  from?: string;
  /** ISO-8601 timestamp (exclusive). */
  to?: string;
}

export const qualityApi = {
  reviewerQuality: async (
    projectId: string,
    range: QualityRangeParams = {},
  ): Promise<ReviewerQualityRow[]> => {
    const r = await api.get<{ items: ReviewerQualityRow[] }>(
      `/projects/${projectId}/stats/reviewer-quality`,
      { params: range },
    );
    return r.data.items;
  },
  retrainHistory: async (
    projectId: string,
    limit = 20,
  ): Promise<RetrainRow[]> => {
    const r = await api.get<{ items: RetrainRow[] }>(
      `/projects/${projectId}/stats/retrain-history`,
      { params: { limit } },
    );
    return r.data.items;
  },
  perClassQuality: async (taskId: string): Promise<PerClassQualityRow[]> => {
    const r = await api.get<{ items: PerClassQualityRow[] }>(
      `/tasks/${taskId}/stats/per-class-quality`,
    );
    return r.data.items;
  },
};
