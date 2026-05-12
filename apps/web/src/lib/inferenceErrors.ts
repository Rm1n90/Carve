// Armin Mehri — mehri.armin@gmail.com
/**
 * Map an axios error from any inference endpoint into a friendly,
 * user-facing message.
 *
 * The api translates the model service's structured 503 admission
 * body into a JSON ``detail`` object on the response:
 *
 *   {
 *     "detail": {
 *       "code": "gpu_oom_risk" | "gpu_busy",
 *       "cost_class": "sam_text" | "yoloe_pf" | ...,
 *       "free_mb": <int>,         // gpu_oom_risk only
 *       "needed_mb": <int>,       // gpu_oom_risk only
 *       "message": "<human-readable>"
 *     }
 *   }
 *
 * Legacy errors keep returning ``detail`` as a string code (e.g.
 * ``"model_service_unreachable"``). This helper handles both.
 */

interface AdmissionDetail {
  code?: string;
  error?: string;
  message?: string;
  free_mb?: number;
  needed_mb?: number;
  cost_class?: string;
}

interface AxiosLikeError {
  response?: {
    status?: number;
    data?: { detail?: unknown } | string;
  };
  message?: string;
}

function readDetail(err: unknown): AdmissionDetail | string | null {
  const e = err as AxiosLikeError | undefined;
  const data = e?.response?.data;
  if (data == null) return null;
  if (typeof data === "string") return data;
  const detail = (data as { detail?: unknown }).detail;
  if (detail == null) return null;
  if (typeof detail === "string") return detail;
  if (typeof detail === "object") return detail as AdmissionDetail;
  return null;
}

function inferenceCode(detail: AdmissionDetail | string | null): string | null {
  if (detail == null) return null;
  if (typeof detail === "string") return detail;
  return detail.code ?? detail.error ?? null;
}

/** Return a friendly message for the given inference error, or
 * ``null`` when it doesn't look like one we have specific copy for. */
export function inferenceErrorMessage(err: unknown): string | null {
  const detail = readDetail(err);
  const code = inferenceCode(detail);
  if (code === "gpu_oom_risk" && typeof detail === "object" && detail !== null) {
    const need = detail.needed_mb;
    const free = detail.free_mb;
    if (typeof need === "number" && typeof free === "number") {
      return (
        `Not enough GPU memory: this job needs ~${need} MB, but only ` +
        `${free} MB is free. Try again after the current job finishes, ` +
        `or unload other models from the System page.`
      );
    }
    return (
      "Not enough GPU memory for this job. Try again after the current " +
      "job finishes, or unload other models from the System page."
    );
  }
  if (code === "gpu_busy") {
    return "GPU is busy with another inference job. Try again in a moment.";
  }
  if (code === "model_service_unreachable") {
    return (
      "Inference service is unreachable. Make sure the model container is " +
      "running and try again."
    );
  }
  if (code === "sam3_not_enabled" || code === "sam3p1_not_enabled") {
    return "This action requires SAM 3 / SAM 3.1 — switch your active SAM variant in My Model.";
  }
  if (typeof detail === "object" && detail !== null && detail.message) {
    return String(detail.message);
  }
  return null;
}

/** True when the error is one of our inference-specific failures
 * (admission, missing model, etc.). Callers can use this to decide
 * whether to overlay a custom toast vs. fall through to a generic
 * "Request failed" message. */
export function isInferenceError(err: unknown): boolean {
  return inferenceErrorMessage(err) !== null;
}
