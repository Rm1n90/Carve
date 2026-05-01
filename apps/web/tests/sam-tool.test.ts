import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/api/sam", () => ({
  samApi: {
    encode: vi.fn(),
    decode: vi.fn(),
  },
}));

import { useAnnotations } from "@/state/annotations";
import { SamTool } from "@/canvas/tools/SamTool";
import { samApi } from "@/api/sam";

describe("SamTool", () => {
  beforeEach(() => {
    useAnnotations.getState().reset([]);
    vi.clearAllMocks();
  });

  afterEach(() => {
    useAnnotations.getState().reset([]);
  });

  it("activate calls /sam/encode and caches the image_hash", async () => {
    (samApi.encode as any).mockResolvedValue({
      image_hash: "abc" + "0".repeat(29),
      shape: [10, 10],
    });
    const tool = new SamTool("asset-1", () => "c-1", () => null);
    expect(tool.isReady()).toBe(false);
    await tool.activate();
    expect(samApi.encode).toHaveBeenCalledWith("asset-1");
    expect(tool.isReady()).toBe(true);
  });

  it("addClick forwards positive (left) and negative (right) labels correctly", async () => {
    (samApi.encode as any).mockResolvedValue({
      image_hash: "h" + "0".repeat(31),
      shape: [10, 10],
    });
    (samApi.decode as any).mockResolvedValue({
      counts: "0,5,5",
      size: [10, 10],
      score: 0.9,
    });
    const tool = new SamTool("a", () => "c-1", () => null);
    await tool.activate();
    await tool.addClick({ x: 4, y: 5 }, { pointer: 0 });
    await tool.addClick({ x: 7, y: 8 }, { pointer: 2 });
    const lastCall = (samApi.decode as any).mock.calls.at(-1);
    // v3.8 Phase 1 — addClick now passes an AbortSignal as a 5th arg
    // so a fresh click can cancel a stale decode. Slice the first 4
    // args so this test stays focused on the prompt payload.
    expect(lastCall.slice(0, 4)).toEqual([
      "a",
      "h" + "0".repeat(31),
      [[4, 5], [7, 8]],
      [1, 0],
    ]);
    expect(lastCall[4]).toBeInstanceOf(AbortSignal);
  });

  it("commit writes a mask annotation and resets internal state", async () => {
    (samApi.encode as any).mockResolvedValue({ image_hash: "x".repeat(32), shape: [4, 4] });
    (samApi.decode as any).mockResolvedValue({
      counts: "0,2,2,2,10",
      size: [4, 4],
      score: 0.77,
    });
    let n = 0;
    const tool = new SamTool("a", () => "c-1", () => null, () => `t-${++n}`);
    await tool.activate();
    await tool.addClick({ x: 1, y: 1 }, { pointer: 0 });
    expect(tool.commit()).toBe(true);
    const drafts = Object.values(useAnnotations.getState().byId);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe("mask");
    const g = drafts[0].geometry as any;
    expect(g.kind).toBe("mask_rle");
    expect(g.size).toEqual([4, 4]);
    expect(g.counts).toBe("0,2,2,2,10");
    // After commit the tool should be reset
    expect(tool.commit()).toBe(false);
  });

  it("commit returns false when no active class", async () => {
    (samApi.encode as any).mockResolvedValue({ image_hash: "y".repeat(32), shape: [4, 4] });
    (samApi.decode as any).mockResolvedValue({
      counts: "0,2,2,2,10",
      size: [4, 4],
      score: 0.5,
    });
    const tool = new SamTool("a", () => null, () => null);
    await tool.activate();
    await tool.addClick({ x: 1, y: 1 }, { pointer: 0 });
    expect(tool.commit()).toBe(false);
  });

  it("addClick before activate returns null and does not call decode", async () => {
    const tool = new SamTool("a", () => "c-1", () => null);
    const r = await tool.addClick({ x: 1, y: 1 }, { pointer: 0 });
    expect(r).toBeNull();
    expect(samApi.decode).not.toHaveBeenCalled();
  });

  it("activate is idempotent (concurrent calls share encode work)", async () => {
    let calls = 0;
    (samApi.encode as any).mockImplementation(async () => {
      calls += 1;
      return { image_hash: "h".repeat(32), shape: [10, 10] };
    });
    const tool = new SamTool("a", () => "c-1", () => null);
    await tool.activate();
    await tool.activate(); // second call should be a no-op once cached
    expect(calls).toBe(1);
  });

  it("addClick re-encodes and retries decode once on a 409 hash_mismatch", async () => {
    // First encode → "stale" hash. Second encode (after re-sync) → "fresh".
    let encodeCalls = 0;
    (samApi.encode as any).mockImplementation(async () => {
      encodeCalls += 1;
      return {
        image_hash:
          encodeCalls === 1 ? "stale".padEnd(32, "0") : "fresh".padEnd(32, "0"),
        shape: [10, 10],
      };
    });

    let decodeCalls = 0;
    (samApi.decode as any).mockImplementation(async () => {
      decodeCalls += 1;
      if (decodeCalls === 1) {
        // Server returns 409 — model worker no longer has the embedding.
        const err: any = new Error("embedding_not_loaded");
        err.response = { status: 409, data: { error: "sam_embedding_missing" } };
        throw err;
      }
      // Retry: succeed.
      return { counts: "ok", size: [10, 10], score: 0.9 };
    });

    const resyncMessages: string[] = [];
    const tool = new SamTool(
      "a",
      () => "c-1",
      () => null,
      undefined,
      (msg) => resyncMessages.push(msg),
    );
    await tool.activate();

    const result = await tool.addClick({ x: 1, y: 1 }, { pointer: 0 });
    expect(result).not.toBeNull();
    expect(encodeCalls).toBe(2); // initial + auto re-encode
    expect(decodeCalls).toBe(2); // failing call + retry
    expect(resyncMessages).toEqual(["Re-syncing SAM — try again"]);

    // Retry decode used the freshly-encoded hash, not the stale one.
    const lastDecodeCall = (samApi.decode as any).mock.calls.at(-1);
    expect(lastDecodeCall[1]).toBe("fresh".padEnd(32, "0"));
  });

  it("addClick re-throws when the retry decode also fails", async () => {
    (samApi.encode as any).mockResolvedValue({
      image_hash: "h".repeat(32),
      shape: [10, 10],
    });
    let decodeCalls = 0;
    (samApi.decode as any).mockImplementation(async () => {
      decodeCalls += 1;
      const err: any = new Error("embedding_not_loaded");
      err.response = { status: 409, data: { error: "sam_embedding_missing" } };
      throw err;
    });

    const tool = new SamTool("a", () => "c-1", () => null);
    await tool.activate();

    await expect(
      tool.addClick({ x: 1, y: 1 }, { pointer: 0 }),
    ).rejects.toMatchObject({ response: { status: 409 } });
    // Exactly one retry — the failing call plus the re-sync attempt.
    expect(decodeCalls).toBe(2);
  });

  it("getPositives + getNegatives expose accumulated click prompts (v3.6)", async () => {
    (samApi.encode as any).mockResolvedValue({
      image_hash: "h".repeat(32),
      shape: [10, 10],
    });
    (samApi.decode as any).mockResolvedValue({
      counts: "0,1,1",
      size: [10, 10],
      score: 0.9,
    });
    const tool = new SamTool("a", () => "c-1", () => null);
    await tool.activate();
    expect(tool.getPositives()).toEqual([]);
    expect(tool.getNegatives()).toEqual([]);
    await tool.addClick({ x: 4, y: 5 }, { pointer: 0 });
    await tool.addClick({ x: 7, y: 8 }, { pointer: 2 });
    await tool.addClick({ x: 9, y: 1 }, { pointer: 0 });
    // Coordinates are rounded by addClick — assert that here too.
    expect(tool.getPositives()).toEqual([
      [4, 5],
      [9, 1],
    ]);
    expect(tool.getNegatives()).toEqual([[7, 8]]);
  });

  it("commit clears positives, negatives, and lastResult (v3.6)", async () => {
    (samApi.encode as any).mockResolvedValue({
      image_hash: "h".repeat(32),
      shape: [4, 4],
    });
    (samApi.decode as any).mockResolvedValue({
      counts: "0,2,2",
      size: [4, 4],
      score: 0.8,
    });
    const tool = new SamTool("a", () => "c-1", () => null);
    await tool.activate();
    await tool.addClick({ x: 1, y: 1 }, { pointer: 0 });
    await tool.addClick({ x: 2, y: 2 }, { pointer: 2 });
    expect(tool.getPositives()).toHaveLength(1);
    expect(tool.getNegatives()).toHaveLength(1);
    expect(tool.getLastResult()).not.toBeNull();
    expect(tool.commit()).toBe(true);
    expect(tool.getPositives()).toEqual([]);
    expect(tool.getNegatives()).toEqual([]);
    expect(tool.getLastResult()).toBeNull();
  });

  it("getLastResult returns null before any decode and the latest result after (v3.6)", async () => {
    (samApi.encode as any).mockResolvedValue({
      image_hash: "h".repeat(32),
      shape: [4, 4],
    });
    (samApi.decode as any)
      .mockResolvedValueOnce({ counts: "first", size: [4, 4], score: 0.5 })
      .mockResolvedValueOnce({ counts: "second", size: [4, 4], score: 0.9 });
    const tool = new SamTool("a", () => "c-1", () => null);
    expect(tool.getLastResult()).toBeNull();
    await tool.activate();
    expect(tool.getLastResult()).toBeNull();
    await tool.addClick({ x: 1, y: 1 }, { pointer: 0 });
    expect(tool.getLastResult()?.counts).toBe("first");
    await tool.addClick({ x: 2, y: 2 }, { pointer: 0 });
    expect(tool.getLastResult()?.counts).toBe("second");
  });

  // ----- v3.8 Phase 1 — polygon commit + popLastClick + abort signal -----

  it("commit emits a polygon annotation when the decode result has a polygon", async () => {
    (samApi.encode as any).mockResolvedValue({ image_hash: "p".repeat(32), shape: [10, 10] });
    (samApi.decode as any).mockResolvedValue({
      counts: "ignored",
      size: [10, 10],
      score: 0.95,
      polygon: [
        [1, 1],
        [9, 1],
        [9, 9],
        [1, 9],
      ],
    });
    let n = 0;
    const tool = new SamTool("a", () => "c-1", () => null, () => `t-${++n}`);
    await tool.activate();
    await tool.addClick({ x: 5, y: 5 }, { pointer: 0 });
    expect(tool.commit()).toBe(true);
    const drafts = Object.values(useAnnotations.getState().byId);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe("polygon");
    const g = drafts[0].geometry as any;
    expect(g.kind).toBe("polygon");
    expect(g.points).toEqual([
      [1, 1],
      [9, 1],
      [9, 9],
      [1, 9],
    ]);
  });

  it("commit falls back to a mask annotation when polygon is empty (legacy SAM 3 factory)", async () => {
    (samApi.encode as any).mockResolvedValue({ image_hash: "m".repeat(32), shape: [4, 4] });
    (samApi.decode as any).mockResolvedValue({
      counts: "0,2,2,2,10",
      size: [4, 4],
      score: 0.5,
      polygon: [],
    });
    const tool = new SamTool("a", () => "c-1", () => null);
    await tool.activate();
    await tool.addClick({ x: 1, y: 1 }, { pointer: 0 });
    expect(tool.commit()).toBe(true);
    const drafts = Object.values(useAnnotations.getState().byId);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe("mask");
  });

  it("commit(classId) overrides the active class for the digit-shortcut path", async () => {
    (samApi.encode as any).mockResolvedValue({ image_hash: "x".repeat(32), shape: [10, 10] });
    (samApi.decode as any).mockResolvedValue({
      counts: "ignored",
      size: [10, 10],
      score: 0.9,
      polygon: [
        [0, 0],
        [9, 0],
        [9, 9],
      ],
    });
    const tool = new SamTool("a", () => "active-cls", () => null);
    await tool.activate();
    await tool.addClick({ x: 5, y: 5 }, { pointer: 0 });
    expect(tool.commit("override-cls")).toBe(true);
    const drafts = Object.values(useAnnotations.getState().byId);
    expect(drafts[0].classId).toBe("override-cls");
  });

  it("popLastClick removes the last point and re-decodes with the rest", async () => {
    (samApi.encode as any).mockResolvedValue({ image_hash: "h".repeat(32), shape: [10, 10] });
    (samApi.decode as any).mockResolvedValue({
      counts: "x",
      size: [10, 10],
      score: 0.7,
      polygon: [],
    });
    const tool = new SamTool("a", () => "c-1", () => null);
    await tool.activate();
    await tool.addClick({ x: 1, y: 1 }, { pointer: 0 });
    await tool.addClick({ x: 2, y: 2 }, { pointer: 2 });
    await tool.addClick({ x: 3, y: 3 }, { pointer: 0 });
    (samApi.decode as any).mockClear();
    const result = await tool.popLastClick();
    expect(result).not.toBeNull();
    // Last positive click should be gone — only the first positive +
    // the negative remain.
    expect(tool.getPositives()).toEqual([[1, 1]]);
    expect(tool.getNegatives()).toEqual([[2, 2]]);
    const decodeCall = (samApi.decode as any).mock.calls.at(-1);
    expect(decodeCall[2]).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(decodeCall[3]).toEqual([1, 0]);
  });

  it("popLastClick returns null and clears lastResult when no clicks remain", async () => {
    (samApi.encode as any).mockResolvedValue({ image_hash: "h".repeat(32), shape: [10, 10] });
    (samApi.decode as any).mockResolvedValue({
      counts: "x",
      size: [10, 10],
      score: 0.7,
      polygon: [],
    });
    const tool = new SamTool("a", () => "c-1", () => null);
    await tool.activate();
    await tool.addClick({ x: 1, y: 1 }, { pointer: 0 });
    expect(await tool.popLastClick()).toBeNull();
    expect(tool.getPositives()).toEqual([]);
    expect(tool.getLastResult()).toBeNull();
  });

  // ----- v3.8 Phase 2 — Box mode via /sam/decode --------------------------

  it("setBox issues a box-only decode and caches the box for refinement", async () => {
    (samApi.encode as any).mockResolvedValue({ image_hash: "b".repeat(32), shape: [50, 50] });
    (samApi.decode as any).mockResolvedValue({
      counts: "x",
      size: [50, 50],
      score: 0.81,
      polygon: [
        [10, 20],
        [40, 20],
        [40, 45],
        [10, 45],
      ],
    });
    const tool = new SamTool("asset-x", () => "c-1", () => null);
    tool.setMode("box");
    await tool.activate();
    const result = await tool.setBox([10, 20, 40, 45]);
    expect(result).not.toBeNull();
    expect(tool.getBox()).toEqual([10, 20, 40, 45]);
    const call = (samApi.decode as any).mock.calls[0];
    expect(call[2]).toEqual([]);
    expect(call[3]).toEqual([]);
    expect(call[5]).toEqual([10, 20, 40, 45]);
  });

  it("addClick after setBox includes the cached box on every decode", async () => {
    (samApi.encode as any).mockResolvedValue({ image_hash: "b".repeat(32), shape: [100, 100] });
    (samApi.decode as any).mockResolvedValue({
      counts: "x",
      size: [100, 100],
      score: 0.7,
      polygon: [],
    });
    const tool = new SamTool("a", () => "c-1", () => null);
    tool.setMode("box");
    await tool.activate();
    await tool.setBox([20, 30, 60, 70]);
    (samApi.decode as any).mockClear();
    await tool.addClick({ x: 35, y: 50 }, { pointer: 0 });
    await tool.addClick({ x: 50, y: 60 }, { pointer: 2 });
    const calls = (samApi.decode as any).mock.calls;
    expect(calls).toHaveLength(2);
    // Each refinement decode carries the same cached box and the
    // accumulated points/labels.
    expect(calls[0][2]).toEqual([[35, 50]]);
    expect(calls[0][3]).toEqual([1]);
    expect(calls[0][5]).toEqual([20, 30, 60, 70]);
    expect(calls[1][2]).toEqual([[35, 50], [50, 60]]);
    expect(calls[1][3]).toEqual([1, 0]);
    expect(calls[1][5]).toEqual([20, 30, 60, 70]);
  });

  it("reset and setMode clear the cached box", async () => {
    (samApi.encode as any).mockResolvedValue({ image_hash: "b".repeat(32), shape: [10, 10] });
    (samApi.decode as any).mockResolvedValue({
      counts: "x",
      size: [10, 10],
      score: 0.5,
      polygon: [],
    });
    const tool = new SamTool("a", () => "c-1", () => null);
    tool.setMode("box");
    await tool.activate();
    await tool.setBox([1, 2, 3, 4]);
    expect(tool.getBox()).toEqual([1, 2, 3, 4]);
    tool.reset();
    expect(tool.getBox()).toBeNull();

    await tool.setBox([5, 6, 7, 8]);
    expect(tool.getBox()).toEqual([5, 6, 7, 8]);
    tool.setMode("point");
    expect(tool.getBox()).toBeNull();
  });

  it("addClick aborts a pending decode when a fresh click lands", async () => {
    (samApi.encode as any).mockResolvedValue({ image_hash: "h".repeat(32), shape: [10, 10] });
    const signals: AbortSignal[] = [];
    (samApi.decode as any).mockImplementation(
      async (
        _aid: string,
        _hash: string,
        _pts: unknown,
        _lbls: unknown,
        signal?: AbortSignal,
      ) => {
        if (signal) signals.push(signal);
        return { counts: "x", size: [10, 10], score: 0.5, polygon: [] };
      },
    );
    const tool = new SamTool("a", () => "c-1", () => null);
    await tool.activate();
    // First click in flight; do not await before the second.
    const p1 = tool.addClick({ x: 1, y: 1 }, { pointer: 0 });
    const p2 = tool.addClick({ x: 2, y: 2 }, { pointer: 0 });
    await Promise.all([p1, p2]);
    expect(signals.length).toBe(2);
    // Second click's arrival should have aborted the first.
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it("addClick does NOT retry on non-409 errors", async () => {
    (samApi.encode as any).mockResolvedValue({
      image_hash: "h".repeat(32),
      shape: [10, 10],
    });
    let decodeCalls = 0;
    (samApi.decode as any).mockImplementation(async () => {
      decodeCalls += 1;
      const err: any = new Error("upstream");
      err.response = { status: 502, data: { error: "sam_model_failed" } };
      throw err;
    });

    const tool = new SamTool("a", () => "c-1", () => null);
    await tool.activate();

    await expect(
      tool.addClick({ x: 1, y: 1 }, { pointer: 0 }),
    ).rejects.toMatchObject({ response: { status: 502 } });
    // No retry path for 502 — single decode call.
    expect(decodeCalls).toBe(1);
  });
});
