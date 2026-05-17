/**
 * describeSamError — busy / OOM messaging contract.
 *
 * Defends the fix for the user-reported bug:
 *   "I was doing auto annotation with SAM3.1, then I selected the Smart
 *   tools with point and tried to do some point, it says SAM failed to
 *   auto annotate but the auto annotation in batch is keep going."
 *
 * Root cause: a concurrent batch holds the model service's admission
 * semaphore, so the synchronous SAM click round-trips a structured 503
 * with ``detail.code = "gpu_busy"``. describeSamError used to fall
 * through to a generic ``status === 503`` branch that read "SAM
 * unavailable — model service is not running" — which is wrong: the
 * service IS running, it's just saturated. This test pins the friendly
 * "GPU is busy" copy and protects the delegation to
 * ``inferenceErrorMessage``.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/canvas/App", () => ({ CanvasApp: class {} }));

import { describeSamError } from "@/components/annotation/AnnotationCanvas";

/** Construct an axios-shaped 503 error with a structured admission body. */
function admission503(code: string, message?: string): Error {
  const err = new Error(message ?? code);
  (err as { response?: unknown }).response = {
    status: 503,
    data: {
      detail: {
        code,
        cost_class: "sam_image",
        message:
          message
          ?? "GPU is busy with another inference job. Try again in a moment.",
      },
    },
  };
  return err;
}

function admissionOom503(freeMb: number, neededMb: number): Error {
  const err = new Error("gpu_oom_risk");
  (err as { response?: unknown }).response = {
    status: 503,
    data: {
      detail: {
        code: "gpu_oom_risk",
        cost_class: "sam_image",
        free_mb: freeMb,
        needed_mb: neededMb,
        message: "Not enough GPU memory",
      },
    },
  };
  return err;
}

/** SAM lifecycle 503 — the model isn't ready yet (still respected). */
function samNotReady503(state: "loading" | "idle" | "error"): Error {
  const err = new Error("sam_not_ready");
  (err as { response?: unknown }).response = {
    status: 503,
    data: {
      error: "sam_not_ready",
      state,
      detail: `sam_${state}`,
    },
  };
  return err;
}

/** Pre-admission 503 with no structured body (legacy contract). */
function legacy503(): Error {
  const err = new Error("Service Unavailable");
  (err as { response?: unknown }).response = {
    status: 503,
    data: undefined,
  };
  return err;
}

describe("describeSamError — admission code routing", () => {
  it("returns 'GPU is busy' copy for gpu_busy (concurrent batch scenario)", () => {
    // Arrange
    const err = admission503("gpu_busy");

    // Act
    const message = describeSamError(err);

    // Assert
    expect(message.toLowerCase()).toContain("gpu");
    expect(message.toLowerCase()).toContain("busy");
    expect(message).not.toContain("not running");
  });

  it("returns specific OOM copy for gpu_oom_risk with VRAM hints", () => {
    // Arrange
    const err = admissionOom503(1200, 3000);

    // Act
    const message = describeSamError(err);

    // Assert
    expect(message).toContain("1200");
    expect(message).toContain("3000");
    expect(message.toLowerCase()).toContain("memory");
  });

  it("still surfaces the SAM lifecycle 'loading' branch when sam_not_ready fires", () => {
    // Arrange — the sam_not_ready envelope lives at data.error, not
    // data.detail.code, so it falls through inferenceErrorMessage and
    // hits the existing SAM-lifecycle branch.
    const err = samNotReady503("loading");

    // Act
    const message = describeSamError(err);

    // Assert
    expect(message.toLowerCase()).toContain("loading");
  });

  it("keeps the legacy 'service is not running' copy for unstructured 503s", () => {
    // Arrange
    const err = legacy503();

    // Act
    const message = describeSamError(err);

    // Assert — pre-admission deployments without a structured body
    // still hit the original fallback so we don't regress that case.
    expect(message.toLowerCase()).toContain("not running");
  });

  it("returns 'unreachable' copy when the model service is actually unreachable", () => {
    // Arrange
    const err = admission503(
      "model_service_unreachable",
      "Inference service is unreachable. Make sure the model container is running and try again.",
    );

    // Act
    const message = describeSamError(err);

    // Assert
    expect(message.toLowerCase()).toContain("unreachable");
  });
});
