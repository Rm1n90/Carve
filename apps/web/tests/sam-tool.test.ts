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
    expect(lastCall).toEqual([
      "a",
      "h" + "0".repeat(31),
      [[4, 5], [7, 8]],
      [1, 0],
    ]);
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
});
