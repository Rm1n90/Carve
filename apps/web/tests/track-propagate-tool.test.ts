import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/api/sam_track", () => ({
  samTrackApi: {
    start: vi.fn(),
    addObject: vi.fn(),
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

  it("start opens a session (legacy single-object convenience)", async () => {
    (samTrackApi.start as any).mockResolvedValue({
      session_id: "S-1",
      mask_at_start: { counts: "1", size: [1, 1] },
    });
    (samTrackApi.addObject as any).mockResolvedValue({ obj_id: 1, frame_idx: 0 });
    const tool = new TrackPropagateTool("a-1", () => "c-1");
    await tool.start({ frameIdx: 0, points: [[10, 20]], labels: [1] });
    expect(samTrackApi.start).toHaveBeenCalledWith("a-1", 0, [], []);
    expect(samTrackApi.addObject).toHaveBeenCalledWith("a-1", "S-1", {
      frame_idx: 0,
      obj_id: 1,
      points: [[10, 20]],
      labels: [1],
    });
    expect(tool.isActive()).toBe(true);
  });

  it("startEmpty opens a session with no objects", async () => {
    (samTrackApi.start as any).mockResolvedValue({
      session_id: "S-empty",
      mask_at_start: { counts: "", size: [0, 0] },
    });
    const tool = new TrackPropagateTool("a-1", () => "c-1");
    await tool.startEmpty({ frameIdx: 5 });
    expect(samTrackApi.start).toHaveBeenCalledWith("a-1", 5, [], []);
    expect(tool.isActive()).toBe(true);
    expect(tool.getObjectIds()).toEqual([]);
    expect(samTrackApi.addObject).not.toHaveBeenCalled();
  });

  it("addObjectAtFrame assigns incrementing obj_ids", async () => {
    (samTrackApi.start as any).mockResolvedValue({
      session_id: "S-1",
      mask_at_start: { counts: "", size: [0, 0] },
    });
    (samTrackApi.addObject as any).mockImplementation(
      async (_aid: string, _sid: string, body: any) => ({
        obj_id: body.obj_id,
        frame_idx: body.frame_idx,
      }),
    );
    const tool = new TrackPropagateTool("a-1", () => "c-1");
    await tool.startEmpty();
    const a = await tool.addObjectAtFrame(0, [[1, 1]], [1], "c-1");
    const b = await tool.addObjectAtFrame(0, [[2, 2]], [1], "c-2");
    const c = await tool.addObjectAtFrame(2, [[3, 3]], [0], "c-1");
    expect(a).toBe(1);
    expect(b).toBe(2);
    expect(c).toBe(3);
    expect(tool.getObjectIds()).toEqual([1, 2, 3]);
  });

  it("addObjectAtFrame calls samTrackApi.addObject with the right body", async () => {
    (samTrackApi.start as any).mockResolvedValue({
      session_id: "S-9",
      mask_at_start: { counts: "", size: [0, 0] },
    });
    (samTrackApi.addObject as any).mockResolvedValue({ obj_id: 1, frame_idx: 7 });
    const tool = new TrackPropagateTool("a-9", () => "c-1");
    await tool.startEmpty();
    await tool.addObjectAtFrame(7, [[10, 20], [30, 40]], [1, 0], "c-X");
    expect(samTrackApi.addObject).toHaveBeenCalledWith("a-9", "S-9", {
      frame_idx: 7,
      obj_id: 1,
      points: [[10, 20], [30, 40]],
      labels: [1, 0],
    });
  });

  it("addObjectAtFrame throws if session not started", async () => {
    const tool = new TrackPropagateTool("a-1", () => "c-1");
    await expect(
      tool.addObjectAtFrame(0, [[1, 1]], [1], "c-1"),
    ).rejects.toThrow();
  });

  it("step collects per-object frames", async () => {
    (samTrackApi.start as any).mockResolvedValue({
      session_id: "S-1",
      mask_at_start: { counts: "", size: [0, 0] },
    });
    (samTrackApi.step as any).mockResolvedValue({
      steps: [
        {
          frame_idx: 0,
          objects: [
            { obj_id: 1, counts: "0,2", size: [4, 4], score: 1.0 },
            { obj_id: 2, counts: "0,3", size: [4, 4], score: 0.9 },
          ],
        },
        {
          frame_idx: 1,
          objects: [
            { obj_id: 1, counts: "0,4", size: [4, 4], score: 1.0 },
            { obj_id: 2, counts: "0,5", size: [4, 4], score: 0.8 },
          ],
        },
      ],
    });
    const tool = new TrackPropagateTool("a-1", () => "c-1");
    await tool.startEmpty();
    const r = await tool.step(2);
    expect(r).toHaveLength(2);
    expect(r[0].objects).toHaveLength(2);
    expect(r[0].objects[0].obj_id).toBe(1);
    const collected = tool.getCollectedFrames();
    expect(collected).toHaveLength(2);
    expect(collected[1].objects[1].obj_id).toBe(2);
  });

  it("step accumulates frames across multiple calls", async () => {
    (samTrackApi.start as any).mockResolvedValue({
      session_id: "S-1",
      mask_at_start: { counts: "", size: [0, 0] },
    });
    (samTrackApi.step as any)
      .mockResolvedValueOnce({
        steps: [
          {
            frame_idx: 0,
            objects: [{ obj_id: 1, counts: "0,2", size: [4, 4], score: 1.0 }],
          },
          {
            frame_idx: 1,
            objects: [{ obj_id: 1, counts: "0,3", size: [4, 4], score: 1.0 }],
          },
        ],
      })
      .mockResolvedValueOnce({
        steps: [
          {
            frame_idx: 2,
            objects: [{ obj_id: 1, counts: "0,4", size: [4, 4], score: 1.0 }],
          },
        ],
      });
    const tool = new TrackPropagateTool("a-1", () => "c-1");
    await tool.startEmpty();
    const r1 = await tool.step(2);
    expect(r1).toHaveLength(2);
    const r2 = await tool.step(1);
    expect(r2).toHaveLength(1);
    expect(tool.getCollectedFrames()).toHaveLength(3);
  });

  it("commit creates one annotation per (frame, obj_id) with shared track_id per obj_id", async () => {
    (samTrackApi.start as any).mockResolvedValue({
      session_id: "S-1",
      mask_at_start: { counts: "", size: [0, 0] },
    });
    (samTrackApi.addObject as any).mockImplementation(
      async (_aid: string, _sid: string, body: any) => ({
        obj_id: body.obj_id,
        frame_idx: body.frame_idx,
      }),
    );
    (samTrackApi.step as any).mockResolvedValue({
      steps: [
        {
          frame_idx: 0,
          objects: [
            { obj_id: 1, counts: "0,2", size: [4, 4], score: 1.0 },
            { obj_id: 2, counts: "0,3", size: [4, 4], score: 0.9 },
          ],
        },
        {
          frame_idx: 1,
          objects: [
            { obj_id: 1, counts: "0,4", size: [4, 4], score: 1.0 },
            { obj_id: 2, counts: "0,5", size: [4, 4], score: 0.8 },
          ],
        },
      ],
    });
    let trackCounter = 0;
    let tempCounter = 0;
    const tool = new TrackPropagateTool(
      "a-1",
      () => "c-active",
      () => `tr-${++trackCounter}`,
      () => `t-${++tempCounter}`,
    );
    await tool.startEmpty();
    await tool.addObjectAtFrame(0, [[1, 1]], [1], "c-A");
    await tool.addObjectAtFrame(0, [[2, 2]], [1], "c-B");
    await tool.step(2);
    const map: Record<number, string> = { 0: "frame-0", 1: "frame-1" };
    const count = tool.commit(map);
    expect(count).toBe(4); // 2 frames × 2 objects
    const drafts = Object.values(useAnnotations.getState().byId);
    expect(drafts).toHaveLength(4);
    expect(drafts.every((d) => d.kind === "mask")).toBe(true);
    // Each obj_id should have a distinct class
    const aClass = drafts.filter((d) => d.classId === "c-A");
    const bClass = drafts.filter((d) => d.classId === "c-B");
    expect(aClass).toHaveLength(2);
    expect(bClass).toHaveLength(2);
    // Track IDs: obj_id=1 → tr-1, obj_id=2 → tr-2 (one per object)
    expect(trackCounter).toBe(2);
  });

  it("commit passes per-obj track_id to the annotation store", async () => {
    (samTrackApi.start as any).mockResolvedValue({
      session_id: "S-1",
      mask_at_start: { counts: "", size: [0, 0] },
    });
    (samTrackApi.addObject as any).mockImplementation(
      async (_aid: string, _sid: string, body: any) => ({
        obj_id: body.obj_id,
        frame_idx: body.frame_idx,
      }),
    );
    (samTrackApi.step as any).mockResolvedValue({
      steps: [
        {
          frame_idx: 0,
          objects: [
            { obj_id: 1, counts: "0,2", size: [4, 4], score: 1.0 },
            { obj_id: 2, counts: "0,3", size: [4, 4], score: 0.9 },
          ],
        },
        {
          frame_idx: 1,
          objects: [
            { obj_id: 1, counts: "0,4", size: [4, 4], score: 1.0 },
            { obj_id: 2, counts: "0,5", size: [4, 4], score: 0.8 },
          ],
        },
      ],
    });
    let trackCounter = 0;
    let tempCounter = 0;
    const tool = new TrackPropagateTool(
      "a-1",
      () => "c-active",
      () => `tr-${++trackCounter}`,
      () => `t-${++tempCounter}`,
    );
    await tool.startEmpty();
    await tool.addObjectAtFrame(0, [[1, 1]], [1], "c-A");
    await tool.addObjectAtFrame(0, [[2, 2]], [1], "c-B");
    await tool.step(2);
    tool.commit({ 0: "frame-0", 1: "frame-1" });

    const drafts = Object.values(useAnnotations.getState().byId);
    // Each obj_id has its own track_id; 4 drafts total, 2 per obj_id.
    const trackIds = drafts.map((d) => d.trackId);
    expect(trackIds.every((t) => t !== null && t !== undefined)).toBe(true);
    // All drafts whose classId === "c-A" share one track_id (obj_id=1).
    const aTracks = new Set(
      drafts.filter((d) => d.classId === "c-A").map((d) => d.trackId),
    );
    const bTracks = new Set(
      drafts.filter((d) => d.classId === "c-B").map((d) => d.trackId),
    );
    expect(aTracks.size).toBe(1);
    expect(bTracks.size).toBe(1);
    // Different obj_ids must end up with different track_ids.
    const [aOnly] = aTracks;
    const [bOnly] = bTracks;
    expect(aOnly).not.toBe(bOnly);
  });

  it("commit drops frames that are not in the frameId map", async () => {
    (samTrackApi.start as any).mockResolvedValue({
      session_id: "S-1",
      mask_at_start: { counts: "", size: [0, 0] },
    });
    (samTrackApi.addObject as any).mockImplementation(
      async (_aid: string, _sid: string, body: any) => ({
        obj_id: body.obj_id,
        frame_idx: body.frame_idx,
      }),
    );
    (samTrackApi.step as any).mockResolvedValue({
      steps: [
        {
          frame_idx: 0,
          objects: [{ obj_id: 1, counts: "0,2", size: [4, 4], score: 1.0 }],
        },
        {
          frame_idx: 1,
          objects: [{ obj_id: 1, counts: "0,3", size: [4, 4], score: 1.0 }],
        },
        {
          frame_idx: 2,
          objects: [{ obj_id: 1, counts: "0,4", size: [4, 4], score: 1.0 }],
        },
      ],
    });
    const tool = new TrackPropagateTool("a-1", () => "c-1");
    await tool.startEmpty();
    await tool.addObjectAtFrame(0, [[1, 1]], [1], "c-1");
    await tool.step(3);
    expect(tool.commit({ 0: "frame-0", 1: "frame-1" })).toBe(2);
  });

  it("release frees the session and is idempotent", async () => {
    (samTrackApi.start as any).mockResolvedValue({
      session_id: "S-1",
      mask_at_start: { counts: "", size: [0, 0] },
    });
    (samTrackApi.addObject as any).mockResolvedValue({ obj_id: 1, frame_idx: 0 });
    (samTrackApi.release as any).mockResolvedValue(undefined);
    const tool = new TrackPropagateTool("a-1", () => "c-1");
    await tool.start({ frameIdx: 0, points: [[1, 1]], labels: [1] });
    await tool.release();
    expect(tool.isActive()).toBe(false);
    await tool.release();
    expect((samTrackApi.release as any).mock.calls.length).toBe(1);
  });

  it("step before start raises", async () => {
    const tool = new TrackPropagateTool("a-1", () => "c-1");
    await expect(tool.step(1)).rejects.toThrow();
  });

  it("addObjectAtFrame throws on obj_id mismatch and does not mutate classByObjId", async () => {
    (samTrackApi.start as any).mockResolvedValue({
      session_id: "S-mm",
      mask_at_start: { counts: "", size: [0, 0] },
    });
    // First call: succeeds normally → obj_id 1 registered.
    (samTrackApi.addObject as any).mockResolvedValueOnce({
      obj_id: 1,
      frame_idx: 0,
    });
    // Second call: server returns a DIFFERENT obj_id than what was sent.
    (samTrackApi.addObject as any).mockResolvedValueOnce({
      obj_id: 99,
      frame_idx: 0,
    });
    const tool = new TrackPropagateTool("a-1", () => "c-1");
    await tool.startEmpty();
    await tool.addObjectAtFrame(0, [[1, 1]], [1], "c-A");
    expect(tool.getObjectIds()).toEqual([1]);

    await expect(
      tool.addObjectAtFrame(0, [[2, 2]], [1], "c-B"),
    ).rejects.toThrow(/obj_id mismatch/);
    // classByObjId must NOT have been mutated by the failed call: only obj_id=1
    // remains. The "ghost" obj_id=2 (the one we tried to send) and obj_id=99
    // (the one the server returned) must both be absent.
    expect(tool.getObjectIds()).toEqual([1]);
  });

  it("commit writes 15 annotations for 3 objects across 5 frames with valid UUID track_ids", async () => {
    // Plan 11 Task 6 — multi-object propagate commit verification.
    (samTrackApi.start as any).mockResolvedValue({
      session_id: "S-mux",
      mask_at_start: { counts: "", size: [0, 0] },
    });
    (samTrackApi.addObject as any).mockImplementation(
      async (_aid: string, _sid: string, body: any) => ({
        obj_id: body.obj_id,
        frame_idx: body.frame_idx,
      }),
    );
    // 5 frames × 3 objects each
    const steps = Array.from({ length: 5 }, (_, fi) => ({
      frame_idx: fi,
      objects: [1, 2, 3].map((oid) => ({
        obj_id: oid,
        counts: `0,${fi + oid}`,
        size: [4, 4] as [number, number],
        score: 1.0,
        polygon: [] as [number, number][],
      })),
    }));
    (samTrackApi.step as any).mockResolvedValue({ steps });

    const tool = new TrackPropagateTool("a-mux", () => "c-active");
    await tool.startEmpty();
    await tool.addObjectAtFrame(0, [[1, 1]], [1], "c-A");
    await tool.addObjectAtFrame(0, [[2, 2]], [1], "c-B");
    await tool.addObjectAtFrame(0, [[3, 3]], [1], "c-C");
    await tool.step(5);

    const map: Record<number, string> = {
      0: "f-0",
      1: "f-1",
      2: "f-2",
      3: "f-3",
      4: "f-4",
    };
    const count = tool.commit(map);
    expect(count).toBe(15); // 5 frames × 3 objects

    const drafts = Object.values(useAnnotations.getState().byId);
    expect(drafts).toHaveLength(15);

    // Each obj_id is identified by its classId in this test's setup.
    const byClass: Record<string, typeof drafts> = {};
    for (const d of drafts) {
      const k = d.classId ?? "?";
      (byClass[k] ||= []).push(d);
    }
    expect(byClass["c-A"]).toHaveLength(5);
    expect(byClass["c-B"]).toHaveLength(5);
    expect(byClass["c-C"]).toHaveLength(5);

    // Per obj_id, all 5 frames share the same track_id.
    const aTracks = new Set(byClass["c-A"].map((d) => d.trackId));
    const bTracks = new Set(byClass["c-B"].map((d) => d.trackId));
    const cTracks = new Set(byClass["c-C"].map((d) => d.trackId));
    expect(aTracks.size).toBe(1);
    expect(bTracks.size).toBe(1);
    expect(cTracks.size).toBe(1);

    // Distinct track_ids across obj_ids.
    const allTracks = new Set([...aTracks, ...bTracks, ...cTracks]);
    expect(allTracks.size).toBe(3);

    // Each track_id is a valid UUID v4-ish: 8-4-4-4-12 hex.
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const t of allTracks) {
      expect(typeof t).toBe("string");
      expect(t).toMatch(uuidRe);
    }
  });

  it("addObjectAtFrame succeeds when server returns the matching obj_id", async () => {
    (samTrackApi.start as any).mockResolvedValue({
      session_id: "S-ok",
      mask_at_start: { counts: "", size: [0, 0] },
    });
    (samTrackApi.addObject as any).mockResolvedValue({
      obj_id: 1,
      frame_idx: 0,
    });
    const tool = new TrackPropagateTool("a-1", () => "c-1");
    await tool.startEmpty();
    const id = await tool.addObjectAtFrame(0, [[1, 1]], [1], "c-A");
    expect(id).toBe(1);
    expect(tool.getObjectIds()).toEqual([1]);
  });
});
