// Armin Mehri — mehri.armin@gmail.com
/**
 * Logo AI — logo detection (bounding boxes) through hosted vision LLMs
 * (Anthropic / OpenAI).
 *
 * One image runs synchronously. A scope of many assets becomes a *job*:
 * either realtime (the worker calls the provider for each asset now) or
 * batch (submitted to the provider's batch API, half price, results
 * within 24h and collected server-side). Jobs are rows on the server,
 * so they survive a page reload and are polled through ``getJob``.
 */
import { api } from "./client";

export type LogoAiProviderId = "anthropic" | "openai";
/** How a many-asset run is delivered. */
export type LogoAiDelivery = "realtime" | "batch";
/** A recorded run: the above, or one image run from the editor. */
export type LogoAiRunKind = LogoAiDelivery | "single";
export type LogoAiDetail = "low" | "standard" | "high" | "max";
export type LogoAiTiling = "off" | "auto" | "fine";

export interface LogoAiModel {
  id: string;
  label: string;
  blurb: string;
  /** Accepted effort levels, cheapest first. Empty = no effort control. */
  efforts: string[];
  default_effort: string | null;
  input_usd: number;
  output_usd: number;
  /** False when the provider's batch API does not take the model. */
  supports_batch: boolean;
}

export interface LogoAiProvider {
  id: LogoAiProviderId;
  label: string;
  /** False when the server has no API key for this provider. */
  configured: boolean;
  env_var: string;
  supports_flex: boolean;
  default_model: string;
  /** The model and effort the second pass uses unless the run names
   *  others; null = the run's own detection model and effort. */
  default_check_model: string | null;
  default_check_effort: string | null;
  models: LogoAiModel[];
}

export interface LogoAiConfig {
  /** Whether the caller may use Logo AI on the task asked about. */
  allowed: boolean;
  providers: LogoAiProvider[];
  details: LogoAiDetail[];
  default_detail: LogoAiDetail;
  tilings: LogoAiTiling[];
  default_tiling: LogoAiTiling;
  max_references: number;
}

export interface LogoAiPrompt {
  class_id: string;
  /** What the model should look for; the class name alone if empty. */
  prompt: string;
}

export interface LogoAiReference {
  class_id: string;
  asset_id: string;
  /** xyxy in the source asset's pixels. */
  bbox: [number, number, number, number];
}

export interface LogoAiRunRequest {
  provider: LogoAiProviderId;
  model: string;
  effort?: string | null;
  prompts: LogoAiPrompt[];
  references?: LogoAiReference[];
  detail?: LogoAiDetail;
  tiling?: LogoAiTiling;
  min_confidence?: number;
  /** Keep a box only if at least this percentage of the logo is in
   *  view, by the model's estimate. 0 keeps every box. */
  min_visible?: number;
  overwrite?: boolean;
  /** OpenAI only: near-realtime processing at the batch price. */
  flex?: boolean;
  /** A second look at every box, enlarged, that drops the ones that are
   *  not logos. Realtime and single-image runs only. */
  double_check?: boolean;
  /** Model and effort of that second look; omitted = the provider's
   *  tested default. */
  check_model?: string | null;
  check_effort?: string | null;
}

export interface LogoAiTaskRunRequest extends LogoAiRunRequest {
  /** Subset from the Range scope; omitted = every asset in the task. */
  asset_ids?: string[];
  skip_annotated?: boolean;
}

export interface LogoAiUsage {
  input_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  output_tokens?: number;
  /** Part of ``output_tokens`` spent reasoning (0 if not reported). */
  reasoning_tokens?: number;
  /** Requests the provider answered. */
  requests?: number;
}

export interface LogoAiDetectResponse {
  annotations: Array<{ id: string; class_id: string; geometry: Record<string, unknown> }>;
  annotations_created: number;
  below_threshold: number;
  /** Boxes left out because too little of the logo was in view. */
  mostly_hidden: number;
  /** Boxes the second pass looked at and rejected as not logos. */
  rejected: number;
  /** Flex requests the provider served at the standard price (booked at
   *  the real price; normally zero). */
  served_at_full_price: number;
  overwrite_skipped: boolean;
  usage: LogoAiUsage;
  cost_usd: number;
}

export interface LogoAiEstimate {
  assets: number;
  requests: number;
  image_tokens: number;
  prefix_tokens: number;
  prefix_cached: boolean;
  min_cache_tokens: number;
  output_tokens: number;
  /** Requests of this task's earlier runs (same model and effort) the
   *  figure is averaged over; 0 = a built-in planning figure. */
  based_on_requests: number;
  cost_realtime_usd: number;
  cost_flex_usd: number | null;
  cost_batch_usd: number;
}

export type LogoAiJobStatus =
  | "queued"
  | "running"
  | "preparing"
  | "submitted"
  | "ingesting"
  | "canceling"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "canceled";

export interface LogoAiJob {
  id: string;
  task_id: string;
  delivery: LogoAiRunKind;
  provider: LogoAiProviderId;
  model: string;
  effort: string | null;
  /** The image's name, for a single-image run. */
  label: string | null;
  status: LogoAiJobStatus;
  /** 0..1 across the whole run, whatever phase it is in. */
  progress: number;
  total_assets: number;
  prepared_assets: number;
  done_assets: number;
  failed_assets: number;
  skipped_assets: number;
  annotations_created: number;
  /** Detected boxes the second pass scored as not a logo and dropped. */
  rejected_boxes: number;
  total_requests: number;
  finished_requests: number;
  usage: LogoAiUsage;
  cost_usd: number;
  estimated_cost_usd: number | null;
  errors: string[];
  error: string | null;
  /** What an active run is waiting for (the provider or the network is
   *  away, the provider's batch queue is full), if anything. The run
   *  goes on by itself. */
  notice: string | null;
  /** When a waiting run tries again. */
  resume_after: string | null;
  created_at: string;
  started_at: string | null;
  submitted_at: string | null;
  expires_at: string | null;
  completed_at: string | null;
}

export interface LogoAiFilterRequest {
  /** 0..1 */
  min_confidence: number;
  /** 0..100 */
  min_visible: number;
  /** Limit to these assets; omitted = the whole task. */
  asset_ids?: string[];
}

export interface LogoAiFilterResult {
  /** Boxes in scope that carry model scores and may be filtered. */
  scored: number;
  /** Of those, how many are under a threshold. */
  below: number;
  /** Images with at least one such box. */
  assets: number;
  applied: boolean;
}

/** A task's Logo AI instructions: the texts in force, whether they are
 *  the task's own, the defaults, and the fixed part added after them. */
export interface LogoAiTaskPrompt {
  instructions: string;
  check_instructions: string;
  custom: boolean;
  check_custom: boolean;
  default_instructions: string;
  default_check_instructions: string;
  /** Added after the instructions on every request; not editable. */
  format_preview: string;
  check_format_preview: string;
  max_chars: number;
  /** Shorter than this, the provider does not cache the prompt. */
  cache_min_chars: number;
  updated_at: string | null;
}

const TERMINAL: ReadonlySet<LogoAiJobStatus> = new Set([
  "completed",
  "completed_with_errors",
  "failed",
  "canceled",
]);

export function isLogoAiJobActive(job: Pick<LogoAiJob, "status">): boolean {
  return !TERMINAL.has(job.status);
}

// A vision call with reasoning routinely outlasts the client's default
// 30s ceiling (several tiles, high effort). The proxy allows 30 minutes.
const DETECT_TIMEOUT_MS = 10 * 60_000;

export const logoAiApi = {
  /** Never throws: a failed probe reads as "not available". */
  config: async (taskId?: string): Promise<LogoAiConfig | null> => {
    try {
      const r = await api.get<LogoAiConfig>("/inference/logo-ai/config", {
        params: taskId ? { task_id: taskId } : undefined,
      });
      return r.data;
    } catch {
      return null;
    }
  },

  detect: async (
    assetId: string,
    body: LogoAiRunRequest & { frame_id?: string | null },
  ): Promise<LogoAiDetectResponse> =>
    (
      await api.post<LogoAiDetectResponse>(`/assets/${assetId}/logo-ai/detect`, body, {
        timeout: DETECT_TIMEOUT_MS,
      })
    ).data,

  estimate: async (
    taskId: string,
    body: LogoAiTaskRunRequest,
  ): Promise<LogoAiEstimate> =>
    (await api.post<LogoAiEstimate>(`/tasks/${taskId}/logo-ai/estimate`, body)).data,

  createJob: async (
    taskId: string,
    body: LogoAiTaskRunRequest & { delivery: LogoAiDelivery },
  ): Promise<LogoAiJob> =>
    (await api.post<LogoAiJob>(`/tasks/${taskId}/logo-ai/jobs`, body)).data,

  listJobs: async (taskId: string): Promise<LogoAiJob[]> =>
    (await api.get<LogoAiJob[]>(`/tasks/${taskId}/logo-ai/jobs`)).data,

  getJob: async (taskId: string, jobId: string): Promise<LogoAiJob> =>
    (await api.get<LogoAiJob>(`/tasks/${taskId}/logo-ai/jobs/${jobId}`)).data,

  /** ``force`` closes a batch that is already canceling without
   *  waiting for the provider: results not collected yet are given up. */
  cancelJob: async (taskId: string, jobId: string, force = false): Promise<LogoAiJob> =>
    (
      await api.post<LogoAiJob>(
        `/tasks/${taskId}/logo-ai/jobs/${jobId}/cancel`,
        undefined,
        force ? { params: { force: true } } : undefined,
      )
    ).data,

  getPrompt: async (
    taskId: string,
    params: { provider?: string; model?: string } = {},
  ): Promise<LogoAiTaskPrompt> =>
    (await api.get<LogoAiTaskPrompt>(`/tasks/${taskId}/logo-ai/prompt`, { params })).data,

  /** A blank text, or the default pasted back, means the default. */
  savePrompt: async (
    taskId: string,
    body: { instructions: string | null; check_instructions: string | null },
    params: { provider?: string; model?: string } = {},
  ): Promise<LogoAiTaskPrompt> =>
    (await api.put<LogoAiTaskPrompt>(`/tasks/${taskId}/logo-ai/prompt`, body, { params })).data,

  /** Count what a score filter would remove. Changes nothing. */
  filterPreview: async (
    taskId: string,
    body: LogoAiFilterRequest,
  ): Promise<LogoAiFilterResult> =>
    (await api.post<LogoAiFilterResult>(`/tasks/${taskId}/logo-ai/filter/preview`, body))
      .data,

  /** Delete the scored boxes under the thresholds. Not reversible. */
  filterApply: async (
    taskId: string,
    body: LogoAiFilterRequest,
  ): Promise<LogoAiFilterResult> =>
    (await api.post<LogoAiFilterResult>(`/tasks/${taskId}/logo-ai/filter/apply`, body))
      .data,
};
