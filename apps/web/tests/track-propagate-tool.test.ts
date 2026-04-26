import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/api/sam_track", () => ({
  samTrackApi: {
    start: vi.fn(),
    step: vi.fn(),
    release: vi.fn(),
  },
}));

import { useAnnotations } from "@/state/annotations";
import { samTrackApi } from "@/api/sam_track";
import { TrackPropagateTool } from "@/canvas/tools/TrackPropagateTool";

describe("TrackPropagateTool", () => {
  beforeEach(() => {
    useAnnotations.getState().reset([]);
    vi.clearAllMocks();
  });
  afterEach(() => {
    useAnnotations.getState().reset([]);
  });

  it("start opens a session", async () => {
    (samTrackApi.start as any).mockResolvedValue({
      session_id: "S-1",
      mask_at_start: { counts: "1", size: [1, 1] },
    });
    const tool = new TrackPropagateTool("a-1", () => "c-1");
    await tool.start({ frameIdx: 0, points: [[10, 20]], labels: [1] });
    expect(samTrackApi.start).toHaveBeenCalledWith("a-1", 0, [[10, 20]], [1]);
    expect(tool.isActive()).toBe(true);
  });

  it("step accumulates frames", async () => {
    (samTrackApi.start as any).mockResolvedValue({
      session_id: "S-1", mask_at_start: { counts: "1", size: [1, 1] },
    });
    (samTrackApi.step as any)
      .mockResolvedValueOnce({
        steps: [
          { frame_idx: 0, counts: "0,2", size: [4, 4], score: 1.0 },
          { frame_idx: 1, counts: "0,3", size: [4, 4], score: 1.0 },
        ],
      })
      .mockResolvedValueOnce({
        steps: [
          { frame_idx: 2, counts: "0,4", size: [4, 4], score: 1.0 },
        ],
      });
    const tool = new TrackPropagateTool("a-1", () => "c-1");
    await tool.start({ frameIdx: 0, points: [[1, 1]], labels: [1] });
    const r1 = await tool.step(2);
    expect(r1).toHaveLength(2);
    const r2 = await tool.step(1);
    expect(r2).toHaveLength(1);
  });

  it("commit writes one mask annotation per frame mapped to an id", async () => {
    (samTrackApi.start as any).mockResolvedValue({
      session_id: "S-1", mask_at_start: { counts: "1", size: [1, 1] },
    });
    (samTrackApi.step as any).mockResolvedValue({
      steps: [
        { frame_idx: 0, counts: "0,2", size: [4, 4], score: 1.0 },
        { frame_idx: 1, counts: "0,3", size: [4, 4], score: 1.0 },
        { frame_idx: 2, counts: "0,4", size: [4, 4], score: 1.0 },
      ],
    });
    let n = 0;
    const tool = new TrackPropagateTool(
      "a-1", () => "c-1",
      () => "tr-fixed", () => `t-${++n}`,
    );
    await tool.start({ frameIdx: 0, points: [[1, 1]], labels: [1] });
    await tool.step(3);
    const map: Record<number, string> = { 0: "frame-0", 1: "frame-1" };
    const count = tool.commit(map);
    expect(count).toBe(2); // frame_idx=2 not in map → dropped
    const drafts = Object.values(useAnnotations.getState().byId);
    expect(drafts).toHaveLength(2);
    expect(drafts.every((d) => d.kind === "mask")).toBe(true);
  });

  it("commit returns 0 when no active class", async () => {
    (samTrackApi.start as any).mockResolvedValue({
      session_id: "S-1", mask_at_start: { counts: "1", size: [1, 1] },
    });
    (samTrackApi.step as any).mockResolvedValue({
      steps: [{ frame_idx: 0, counts: "0,2", size: [4, 4], score: 1.0 }],
    });
    const tool = new TrackPropagateTool("a-1", () => null);
    await tool.start({ frameIdx: 0, points: [[1, 1]], labels: [1] });
    await tool.step(1);
    expect(tool.commit({ 0: "frame-0" })).toBe(0);
  });

  it("release frees the session and is idempotent", async () => {
    (samTrackApi.start as any).mockResolvedValue({
      session_id: "S-1", mask_at_start: { counts: "1", size: [1, 1] },
    });
    (samTrackApi.release as any).mockResolvedValue(undefined);
    const tool = new TrackPropagateTool("a-1", () => "c-1");
    await tool.start({ frameIdx: 0, points: [[1, 1]], labels: [1] });
    await tool.release();
    expect(tool.isActive()).toBe(false);
    await tool.release(); // no-op
    expect((samTrackApi.release as any).mock.calls.length).toBe(1);
  });

  it("step before start raises", async () => {
    const tool = new TrackPropagateTool("a-1", () => "c-1");
    await expect(tool.step(1)).rejects.toThrow();
  });
});
