/**
 * End-to-end coverage for the "Polygon approximation points" slider →
 * SAM auto-annotate request body plumbing.
 *
 * Pre-fix, the user's slider value never reached the auto-annotate
 * paths (text + visual, sync + batch) — the model service used the
 * polygonize default regardless of what was set. These tests pin the
 * three layers that had to be fixed:
 *
 *   1. ``epsilonFromPolygonSlider`` — pure math: 0→0.01, 50→0.001, 100→0.0001.
 *   2. ``currentPolygonEpsilonFactor`` — reads from the editor settings store.
 *   3. ``samApi.autoText / autoTextBatch / autoVisual / autoVisualBatch /
 *      textPrompt / boxPrompt`` — forward the value as ``epsilon_factor``
 *      in the request body.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_POLYGON_APPROX_SLIDER,
  currentPolygonEpsilonFactor,
  epsilonFromPolygonSlider,
} from "@/lib/polygon-approx";
import { useEditorSettings } from "@/state/editorSettings";

describe("epsilonFromPolygonSlider", () => {
  it("slider 0 → epsilon 0.01 (coarse, ~5-10 vertices)", () => {
    expect(epsilonFromPolygonSlider(0)).toBeCloseTo(0.01, 6);
  });

  it("slider 50 → epsilon 0.001 (legacy hardcoded default)", () => {
    expect(epsilonFromPolygonSlider(50)).toBeCloseTo(0.001, 6);
  });

  it("slider 100 → epsilon 0.0001 (faithful, many vertices)", () => {
    expect(epsilonFromPolygonSlider(100)).toBeCloseTo(0.0001, 8);
  });

  it("monotonic: higher slider → smaller epsilon (more vertices)", () => {
    expect(epsilonFromPolygonSlider(25)).toBeGreaterThan(
      epsilonFromPolygonSlider(75),
    );
  });

  it("clamps below 0", () => {
    expect(epsilonFromPolygonSlider(-50)).toBeCloseTo(0.01, 6);
  });

  it("clamps above 100", () => {
    expect(epsilonFromPolygonSlider(150)).toBeCloseTo(0.0001, 8);
  });

  it("Armin's reported values (25 and 75) produce visibly different epsilons", () => {
    const eps25 = epsilonFromPolygonSlider(25);
    const eps75 = epsilonFromPolygonSlider(75);
    // The ratio between 25 and 75 is 10x (log-linear scale).
    expect(eps25 / eps75).toBeCloseTo(10, 1);
  });
});

describe("currentPolygonEpsilonFactor (reads editor settings)", () => {
  let original: number;
  beforeEach(() => {
    original = useEditorSettings.getState().polygonApproxPoints;
  });
  afterEach(() => {
    useEditorSettings.getState().set("polygonApproxPoints", original);
  });

  it("uses 55 (default) when the setting matches the project default", () => {
    useEditorSettings.getState().set("polygonApproxPoints", 55);
    expect(currentPolygonEpsilonFactor()).toBeCloseTo(
      epsilonFromPolygonSlider(55),
      8,
    );
  });

  it("reflects the user's chosen slider position (25)", () => {
    useEditorSettings.getState().set("polygonApproxPoints", 25);
    expect(currentPolygonEpsilonFactor()).toBeCloseTo(
      epsilonFromPolygonSlider(25),
      8,
    );
  });

  it("reflects the user's chosen slider position (75)", () => {
    useEditorSettings.getState().set("polygonApproxPoints", 75);
    expect(currentPolygonEpsilonFactor()).toBeCloseTo(
      epsilonFromPolygonSlider(75),
      8,
    );
  });

  it("DEFAULT_POLYGON_APPROX_SLIDER constant matches the default-position default", () => {
    expect(DEFAULT_POLYGON_APPROX_SLIDER).toBe(55);
  });
});

describe("samApi forwards epsilon_factor in request bodies", () => {
  let postSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    postSpy = vi.fn().mockResolvedValue({ data: [] });
    vi.resetModules();
    vi.doMock("@/api/client", () => ({
      api: { post: postSpy, get: vi.fn() },
    }));
  });

  afterEach(() => {
    vi.unmock("@/api/client");
    vi.resetModules();
  });

  it("autoText body includes epsilon_factor when passed", async () => {
    const { samApi } = await import("@/api/sam");
    postSpy.mockResolvedValueOnce({
      data: { annotations_created: 0, per_class: {}, ineligible: [] },
    });
    await samApi.autoText("asset-1", {
      class_ids: ["c-1"],
      threshold: 0.4,
      epsilon_factor: 0.003,
    });
    expect(postSpy).toHaveBeenCalledWith(
      "/assets/asset-1/sam/auto-text",
      expect.objectContaining({ epsilon_factor: 0.003 }),
    );
  });

  it("autoTextBatch body includes epsilon_factor when passed", async () => {
    const { samApi } = await import("@/api/sam");
    postSpy.mockResolvedValueOnce({ data: { job_id: "j-1" } });
    await samApi.autoTextBatch("task-1", {
      class_ids: ["c-1"],
      threshold: 0.4,
      epsilon_factor: 0.0066,
    });
    expect(postSpy).toHaveBeenCalledWith(
      "/tasks/task-1/sam/auto-text-batch",
      expect.objectContaining({ epsilon_factor: 0.0066 }),
    );
  });

  it("autoVisual body includes epsilon_factor when passed", async () => {
    const { samApi } = await import("@/api/sam");
    postSpy.mockResolvedValueOnce({
      data: { annotations_created: 0, per_class: {} },
    });
    await samApi.autoVisual("asset-1", {
      sources: [],
      ref_kind: "bbox",
      threshold: 0.4,
      find_all: true,
      overwrite: false,
      epsilon_factor: 0.002,
    });
    expect(postSpy).toHaveBeenCalledWith(
      "/assets/asset-1/sam/auto-visual",
      expect.objectContaining({ epsilon_factor: 0.002 }),
    );
  });

  it("autoVisualBatch body includes epsilon_factor when passed", async () => {
    const { samApi } = await import("@/api/sam");
    postSpy.mockResolvedValueOnce({ data: { job_id: "j-2" } });
    await samApi.autoVisualBatch("task-1", {
      sources: [],
      ref_kind: "bbox",
      threshold: 0.4,
      find_all: true,
      overwrite: false,
      epsilon_factor: 0.0011,
    });
    expect(postSpy).toHaveBeenCalledWith(
      "/tasks/task-1/sam/auto-visual-batch",
      expect.objectContaining({ epsilon_factor: 0.0011 }),
    );
  });

  it("textPrompt body includes epsilon_factor when passed", async () => {
    const { samApi } = await import("@/api/sam");
    postSpy.mockResolvedValueOnce({ data: [] });
    await samApi.textPrompt("a-1", "bus", null, false, 0.0042);
    expect(postSpy).toHaveBeenCalledWith(
      "/assets/a-1/sam/text-prompt",
      expect.objectContaining({ epsilon_factor: 0.0042 }),
    );
  });

  it("textPrompt body OMITS epsilon_factor when not passed (backward compat)", async () => {
    const { samApi } = await import("@/api/sam");
    postSpy.mockResolvedValueOnce({ data: [] });
    await samApi.textPrompt("a-1", "bus");
    const [, body] = postSpy.mock.calls[0];
    expect(body).not.toHaveProperty("epsilon_factor");
  });

  it("boxPrompt body includes epsilon_factor when passed", async () => {
    const { samApi } = await import("@/api/sam");
    postSpy.mockResolvedValueOnce({ data: [] });
    await samApi.boxPrompt(
      "a-1",
      [[0, 0, 10, 10]],
      [1],
      undefined,
      null,
      0.0033,
    );
    expect(postSpy).toHaveBeenCalledWith(
      "/assets/a-1/sam/box-prompt",
      expect.objectContaining({ epsilon_factor: 0.0033 }),
    );
  });

  it("autoText omits epsilon_factor when not passed (legacy callers)", async () => {
    const { samApi } = await import("@/api/sam");
    postSpy.mockResolvedValueOnce({
      data: { annotations_created: 0, per_class: {}, ineligible: [] },
    });
    await samApi.autoText("asset-1", {
      class_ids: ["c-1"],
      threshold: 0.4,
    });
    const [, body] = postSpy.mock.calls[0];
    expect(body).not.toHaveProperty("epsilon_factor");
  });
});

describe("end-to-end bug scenario: slider 25 vs 75 produces distinct wire payloads", () => {
  let postSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    postSpy = vi.fn().mockResolvedValue({
      data: { annotations_created: 0, per_class: {}, ineligible: [] },
    });
    vi.resetModules();
    vi.doMock("@/api/client", () => ({
      api: { post: postSpy, get: vi.fn() },
    }));
  });

  afterEach(() => {
    vi.unmock("@/api/client");
    vi.resetModules();
  });

  it("simulates the AutoAnnotateDialog wiring: slider position changes the wire body", async () => {
    const { samApi } = await import("@/api/sam");
    const originalSlider =
      useEditorSettings.getState().polygonApproxPoints;
    try {
      // Slider 25 (coarse polygons) — what Armin set.
      useEditorSettings.getState().set("polygonApproxPoints", 25);
      const eps25 = currentPolygonEpsilonFactor();
      await samApi.autoText("asset-1", {
        class_ids: ["c-1"],
        threshold: 0.4,
        epsilon_factor: eps25,
      });

      // Slider 75 (faithful polygons) — what Armin also tried.
      useEditorSettings.getState().set("polygonApproxPoints", 75);
      const eps75 = currentPolygonEpsilonFactor();
      await samApi.autoText("asset-1", {
        class_ids: ["c-1"],
        threshold: 0.4,
        epsilon_factor: eps75,
      });
    } finally {
      useEditorSettings
        .getState()
        .set("polygonApproxPoints", originalSlider);
    }
    const [, body25] = postSpy.mock.calls[0];
    const [, body75] = postSpy.mock.calls[1];
    expect((body25 as { epsilon_factor: number }).epsilon_factor)
      .toBeGreaterThan(
        (body75 as { epsilon_factor: number }).epsilon_factor,
      );
    // The user setting MUST visibly change the wire payload.
    expect((body25 as { epsilon_factor: number }).epsilon_factor)
      .not.toEqual(
        (body75 as { epsilon_factor: number }).epsilon_factor,
      );
  });
});
