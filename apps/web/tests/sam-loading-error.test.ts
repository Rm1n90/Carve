/**
 * SamLoadingError — exhaustive error-shape + state-cleanliness coverage.
 *
 * These tests defend the contract Armin asked for: when the SAM model
 * isn't ready (variant switch, idle eviction, fresh boot), the user's
 * click must NOT poison the tool. The tool must remain usable so a
 * later click — once the model is ready — works without a page refresh.
 *
 * Covers:
 *   • ``asSamLoadingError`` classifier (positive + negative shapes)
 *   • activate(): wraps 503 sam_not_ready, leaves imageHash null,
 *     succeeds on subsequent retry once the backend recovers
 *   • addClick(): on activate-time loading, no click is pushed; on
 *     decode-time loading, the click is popped and encoding cleared
 *   • setBox(): on activate-time loading, no box is set; on
 *     decode-time loading, the box is cleared and encoding invalidated
 *   • setText(): wraps 503 sam_not_ready
 *   • The original bug: switch → click during load → toast → click
 *     after ready works end-to-end, no broken state in between.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/api/sam", () => ({
  samApi: {
    encode: vi.fn(),
    decode: vi.fn(),
    textPrompt: vi.fn(),
  },
}));

import { useAnnotations } from "@/state/annotations";
import {
  SamTool,
  SamLoadingError,
  asSamLoadingError,
} from "@/canvas/tools/SamTool";
import { samApi } from "@/api/sam";

/** Build an axios-shaped 503 sam_not_ready response error. */
function loading503(
  state: "loading" | "idle" | "error" | "unknown",
  detail?: string,
): Error {
  const err = new Error("Request failed with status code 503");
  // Mirrors the AppError envelope FastAPI emits at the response root.
  (err as { response?: unknown }).response = {
    status: 503,
    data: {
      error: "sam_not_ready",
      state,
      detail: detail ?? `sam_${state}`,
    },
  };
  return err;
}

function generic503(): Error {
  const err = new Error("model_service_unreachable");
  (err as { response?: unknown }).response = {
    status: 503,
    data: { error: "model_service_unreachable" },
  };
  return err;
}

function status409(): Error {
  const err = new Error("conflict");
  (err as { response?: unknown }).response = {
    status: 409,
    data: { detail: "embedding_not_loaded" },
  };
  return err;
}

beforeEach(() => {
  useAnnotations.getState().reset([]);
  vi.clearAllMocks();
});

afterEach(() => {
  useAnnotations.getState().reset([]);
});

describe("asSamLoadingError classifier", () => {
  it("recognises the 503 sam_not_ready envelope with state=loading", () => {
    const loading = asSamLoadingError(loading503("loading"));
    expect(loading).toBeInstanceOf(SamLoadingError);
    expect(loading?.samState).toBe("loading");
    expect(loading?.detail).toBe("sam_loading");
  });

  it("recognises state=idle (lazy-load needed)", () => {
    const loading = asSamLoadingError(loading503("idle"));
    expect(loading?.samState).toBe("idle");
  });

  it("recognises state=error (previous load failed)", () => {
    const loading = asSamLoadingError(
      loading503("error", "sam_load_failed: oom"),
    );
    expect(loading?.samState).toBe("error");
    expect(loading?.detail).toContain("oom");
  });

  it("normalises unknown state strings to 'unknown'", () => {
    const err = new Error("503");
    (err as { response?: unknown }).response = {
      status: 503,
      data: { error: "sam_not_ready", state: "marshmallow" },
    };
    expect(asSamLoadingError(err)?.samState).toBe("unknown");
  });

  it("returns null for model_service_unreachable (different 503)", () => {
    expect(asSamLoadingError(generic503())).toBeNull();
  });

  it("returns null for 409", () => {
    expect(asSamLoadingError(status409())).toBeNull();
  });

  it("returns null for a non-axios error (string, null, undefined, plain Error)", () => {
    expect(asSamLoadingError("plain string")).toBeNull();
    expect(asSamLoadingError(null)).toBeNull();
    expect(asSamLoadingError(undefined)).toBeNull();
    expect(asSamLoadingError(new Error("network"))).toBeNull();
  });

  it("returns the same instance when passed an existing SamLoadingError (idempotent)", () => {
    const original = new SamLoadingError("loading", "sam_loading", null);
    expect(asSamLoadingError(original)).toBe(original);
  });
});

describe("SamTool.activate — loading error path", () => {
  it("wraps 503 sam_not_ready as SamLoadingError and leaves imageHash null", async () => {
    (samApi.encode as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      loading503("loading"),
    );
    const tool = new SamTool("a", () => "c-1", () => null);
    await expect(tool.activate()).rejects.toBeInstanceOf(SamLoadingError);
    expect(tool.isReady()).toBe(false);
  });

  it("propagates non-loading errors unchanged (not wrapped)", async () => {
    (samApi.encode as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      generic503(),
    );
    const tool = new SamTool("a", () => "c-1", () => null);
    await expect(tool.activate()).rejects.not.toBeInstanceOf(SamLoadingError);
    expect(tool.isReady()).toBe(false);
  });

  it("retries cleanly after a SamLoadingError — second activate succeeds when backend ready", async () => {
    // Real-world recovery: first call hits a still-loading model and
    // fails with SamLoadingError; once the model is ready the next
    // activate() works without any reset / refresh needed.
    (samApi.encode as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(loading503("loading"))
      .mockResolvedValueOnce({
        image_hash: "ok" + "0".repeat(30),
        shape: [10, 10],
      });
    const tool = new SamTool("a", () => "c-1", () => null);
    await expect(tool.activate()).rejects.toBeInstanceOf(SamLoadingError);
    await tool.activate();
    expect(tool.isReady()).toBe(true);
  });
});

describe("SamTool.addClick — loading error path", () => {
  it("on activate-time loading: throws, no click pushed, imageHash stays null", async () => {
    (samApi.encode as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      loading503("loading"),
    );
    const tool = new SamTool("a", () => "c-1", () => null);
    await expect(
      tool.addClick({ x: 5, y: 5 }, { pointer: 0 }),
    ).rejects.toBeInstanceOf(SamLoadingError);
    expect(tool.getPositives()).toHaveLength(0);
    expect(tool.getNegatives()).toHaveLength(0);
    expect(tool.isReady()).toBe(false);
  });

  it("on decode-time loading: pops the just-pushed click + clears imageHash", async () => {
    // Activate succeeds → click gets pushed → decode fails with
    // sam_not_ready (mid-flight idle eviction / hot-swap). Tool MUST
    // pop the click and invalidate the encoding so the canvas state
    // reflects "click didn't take effect".
    (samApi.encode as ReturnType<typeof vi.fn>).mockResolvedValue({
      image_hash: "h" + "0".repeat(31),
      shape: [10, 10],
    });
    (samApi.decode as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      loading503("loading"),
    );
    const tool = new SamTool("a", () => "c-1", () => null);
    await tool.activate();
    expect(tool.isReady()).toBe(true);

    await expect(
      tool.addClick({ x: 5, y: 5 }, { pointer: 0 }),
    ).rejects.toBeInstanceOf(SamLoadingError);

    expect(tool.getPositives()).toHaveLength(0);
    expect(tool.getNegatives()).toHaveLength(0);
    expect(tool.isReady()).toBe(false);
  });

  it("loading mid-decode does not poison subsequent clicks after recovery", async () => {
    // Full recovery:
    //   1. Activate → ok
    //   2. Click → decode 503 sam_not_ready → click popped, encoding cleared
    //   3. Model becomes ready → next click re-activates + decodes ok
    (samApi.encode as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        image_hash: "h1" + "0".repeat(30),
        shape: [10, 10],
      })
      .mockResolvedValueOnce({
        image_hash: "h2" + "0".repeat(30),
        shape: [10, 10],
      });
    (samApi.decode as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(loading503("loading"))
      .mockResolvedValueOnce({
        counts: "0,4,2,2,2",
        size: [10, 10],
        score: 0.8,
      });
    const tool = new SamTool("a", () => "c-1", () => null);
    await tool.activate();

    await expect(
      tool.addClick({ x: 4, y: 4 }, { pointer: 0 }),
    ).rejects.toBeInstanceOf(SamLoadingError);

    // Second click works — proves the tool self-heals without refresh.
    const r = await tool.addClick({ x: 5, y: 5 }, { pointer: 0 });
    expect(r).not.toBeNull();
    expect(tool.getPositives()).toHaveLength(1);
    expect(tool.isReady()).toBe(true);
  });
});

describe("SamTool.setBox — loading error path", () => {
  // setBox now retries on SamLoadingError (bounded, 4 attempts with
  // 1.5s backoff) to absorb the SAM model warmup window the user hit
  // as "fails then suddenly works". The tests below use a steady
  // loading-503 mock so every retry attempt rejects; the final
  // attempt's error propagates as a SamLoadingError.
  it("on activate-time loading: throws, no box stored", async () => {
    vi.useFakeTimers();
    (samApi.encode as ReturnType<typeof vi.fn>).mockRejectedValue(
      loading503("loading"),
    );
    const tool = new SamTool("a", () => "c-1", () => null);
    tool.setMode("box");
    const p = tool.setBox([0, 0, 10, 10]);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).rejects.toBeInstanceOf(SamLoadingError);
    expect(tool.getBox()).toBeNull();
    vi.useRealTimers();
  });

  it("on decode-time loading: clears the box AND invalidates encoding", async () => {
    vi.useFakeTimers();
    (samApi.encode as ReturnType<typeof vi.fn>).mockResolvedValue({
      image_hash: "h" + "0".repeat(31),
      shape: [10, 10],
    });
    (samApi.decode as ReturnType<typeof vi.fn>).mockRejectedValue(
      loading503("loading"),
    );
    const tool = new SamTool("a", () => "c-1", () => null);
    tool.setMode("box");
    await tool.activate();
    const p = tool.setBox([0, 0, 10, 10]);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).rejects.toBeInstanceOf(SamLoadingError);
    expect(tool.getBox()).toBeNull();
    expect(tool.isReady()).toBe(false);
    vi.useRealTimers();
  });
});

describe("SamTool.setText — loading error path", () => {
  it("wraps 503 sam_not_ready from /sam/text-prompt as SamLoadingError", async () => {
    (samApi.textPrompt as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      loading503("loading"),
    );
    const tool = new SamTool("a", () => "c-1", () => null);
    tool.setMode("text");
    await expect(tool.setText("a dog")).rejects.toBeInstanceOf(
      SamLoadingError,
    );
  });

  it("passes through unrelated errors unchanged", async () => {
    const orig = new Error("network");
    (samApi.textPrompt as ReturnType<typeof vi.fn>).mockRejectedValueOnce(orig);
    const tool = new SamTool("a", () => "c-1", () => null);
    tool.setMode("text");
    await expect(tool.setText("a dog")).rejects.toBe(orig);
  });
});

describe("SamTool — end-to-end: the original bug scenario", () => {
  it("variant switch → click during load → SamLoadingError → click after ready works (no refresh)", async () => {
    // Mirrors what Armin saw:
    //   1. User clicks the new variant in the toolbar → switch starts
    //   2. SamSwitchWatcher's "switching" event drops the canvas's
    //      encoding cache (we simulate that here with invalidateEncoding)
    //   3. User clicks the canvas before the model is ready →
    //      activate() returns 503 sam_not_ready → SamLoadingError
    //   4. Eventually the model finishes loading → next click works
    (samApi.encode as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(loading503("loading"))
      .mockResolvedValueOnce({
        image_hash: "ok" + "0".repeat(30),
        shape: [10, 10],
      });
    (samApi.decode as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      counts: "0,4,2,2,2",
      size: [10, 10],
      score: 0.92,
    });

    const tool = new SamTool("a", () => "c-1", () => null);

    // Simulates: SamSwitchWatcher dispatched "switching" → canvas
    // called invalidateEncoding() on the SamTool.
    tool.invalidateEncoding();
    expect(tool.isReady()).toBe(false);

    // First click during the loading window — toast scenario.
    await expect(
      tool.addClick({ x: 5, y: 5 }, { pointer: 0 }),
    ).rejects.toBeInstanceOf(SamLoadingError);
    expect(tool.getPositives()).toHaveLength(0);

    // SamSwitchWatcher fires `carve:sam-variant-ready` once the model
    // is genuinely loaded — canvas eagerly re-activates the tool. We
    // simulate the user clicking AFTER that — and it must work without
    // any refresh.
    const r = await tool.addClick({ x: 6, y: 6 }, { pointer: 0 });
    expect(r).not.toBeNull();
    expect(tool.getPositives()).toHaveLength(1);
    expect(tool.isReady()).toBe(true);
  });

  it("repeated loading errors don't accumulate phantom clicks", async () => {
    // Stress: user clicks 3x while model still loading; each click
    // must throw, no clicks accumulate, tool stays usable.
    (samApi.encode as ReturnType<typeof vi.fn>)
      .mockRejectedValue(loading503("loading"));
    const tool = new SamTool("a", () => "c-1", () => null);
    for (let i = 0; i < 3; i += 1) {
      await expect(
        tool.addClick({ x: i, y: i }, { pointer: 0 }),
      ).rejects.toBeInstanceOf(SamLoadingError);
    }
    expect(tool.getPositives()).toHaveLength(0);
    expect(tool.getNegatives()).toHaveLength(0);
    expect(tool.isReady()).toBe(false);
  });
});
