// Armin Mehri — mehri.armin@gmail.com
/**
 * Collect from web — a task's keywords and the runs that download images
 * for them (Bing, Wikimedia Commons, Openverse) straight into the task.
 *
 * Runs are rows on the server, worked by their own worker: closing the
 * dialog or reloading the page does not stop one; Stop does.
 */
import { api } from "./client";

export type WebCollectSource =
  | "bing"
  | "yandex"
  | "commons"
  | "openverse"
  | "unsplash"
  | "pexels"
  | "pixabay";

export interface WebCollectSourceInfo {
  name: WebCollectSource;
  label: string;
  /** "web" search engines, "open" licence archives, free "photos" sites. */
  kind: "web" | "open" | "photos";
  /** Ticked in a new run unless changed. */
  default: boolean;
  /** What it still needs (Settings → Collect from web), e.g. "a Pexels API key". */
  needs: string | null;
}
export type WebCollectJobStatus =
  | "queued"
  | "running"
  | "canceling"
  | "completed"
  | "canceled"
  | "failed";
/** done: has its images; exhausted: every source ran out; limited: what it
 * still needed was only on sources stopped for a limit, CAPTCHA or block. */
export type WebCollectKeywordStatus = "pending" | "running" | "done" | "exhausted" | "limited";

/** How one source did in a run. */
export interface WebCollectSourceStat {
  searches: number;
  found: number;
  added: number;
  /** "ok"; "error" (a failed search, retried); "stopped" (a limit, CAPTCHA
   * or block: out of the run, not waited for). */
  status: "ok" | "error" | "stopped";
  /** Why it was stopped. */
  note?: string | null;
}

export interface WebCollectKeyword {
  id: string;
  keyword: string;
  slug: string;
  target: number;
  /** Collected images of this keyword still in the task. */
  have: number;
  /** Every source searched to the end. */
  exhausted: boolean;
}

export interface WebCollectJobKeyword {
  keyword_id: string;
  keyword: string;
  want: number;
  added: number;
  rejected: number;
  status: WebCollectKeywordStatus;
}

export interface WebCollectOptions {
  sources: WebCollectSource[];
  min_side: number;
  filter_ai: boolean;
  filter_watermark: boolean;
  filter_relevance: boolean;
  mode: "per_keyword" | "total";
  restart_search?: boolean;
}

export interface WebCollectJob {
  id: string;
  status: WebCollectJobStatus;
  options: Partial<WebCollectOptions>;
  target: number;
  added: number;
  found: number;
  downloaded: number;
  failed: number;
  rejected: number;
  rejected_by: Record<string, number>;
  source_stats: Record<string, WebCollectSourceStat>;
  searches: number;
  notice: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  keywords: WebCollectJobKeyword[];
}

export interface WebCollectState {
  keywords: WebCollectKeyword[];
  active: WebCollectJob | null;
  recent: WebCollectJob[];
  sources: WebCollectSourceInfo[];
  blocked_counts: Record<string, number>;
  min_side_default: number;
}

export interface WebCollectKeywordIn {
  id?: string;
  keyword: string;
  target: number;
}

export const ACTIVE_STATUSES: WebCollectJobStatus[] = ["queued", "running", "canceling"];

export const webCollectApi = {
  state: async (taskId: string): Promise<WebCollectState> =>
    (await api.get<WebCollectState>(`/tasks/${taskId}/web-collect`)).data,
  saveKeywords: async (taskId: string, keywords: WebCollectKeywordIn[]): Promise<WebCollectState> =>
    (await api.put<WebCollectState>(`/tasks/${taskId}/web-collect/keywords`, { keywords })).data,
  start: async (
    taskId: string,
    options: WebCollectOptions,
    keywordIds?: string[],
  ): Promise<WebCollectJob> =>
    (
      await api.post<WebCollectJob>(`/tasks/${taskId}/web-collect/jobs`, {
        options,
        keyword_ids: keywordIds ?? null,
      })
    ).data,
  cancel: async (taskId: string, jobId: string): Promise<WebCollectJob> =>
    (await api.post<WebCollectJob>(`/tasks/${taskId}/web-collect/jobs/${jobId}/cancel`)).data,
};

/** "keyword", "keyword, 300", "keyword | 300" or "keyword<TAB>300" per line. */
export function parseKeywordList(text: string, defaultTarget: number): WebCollectKeywordIn[] {
  const out: WebCollectKeywordIn[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(.*?)\s*[,|\t;]\s*(\d+)\s*$/);
    const keyword = (m ? m[1] : line).replace(/\s+/g, " ").trim();
    if (!keyword) continue;
    out.push({ keyword, target: m ? Number(m[2]) : defaultTarget });
  }
  return out;
}

/** Split ``total`` over ``n`` keywords as evenly as whole numbers allow. */
export function splitTotal(total: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(total / n);
  const extra = total % n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

export const REJECT_LABELS: Record<string, string> = {
  too_small: "too small",
  not_an_image: "not an image",
  vector_graphic: "vector (SVG)",
  animated: "animated",
  file_too_big: "file too big",
  duplicate: "duplicate",
  near_duplicate: "near duplicate",
  ai_generated: "AI-generated",
  watermark: "watermarked",
  off_topic: "off topic",
  blocked_stock: "stock site",
  blocked_ai: "AI-image site",
  blocked_chinese: "Chinese site",
  blocked_custom: "blocked site",
};
