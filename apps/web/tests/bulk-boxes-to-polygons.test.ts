// Armin Mehri — mehri.armin@gmail.com
//
// Box -> polygon with SAM: the open image goes to the server in one
// call and is applied locally; the task-wide run goes image by image,
// saves each image as it goes, and stops between images on cancel.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  bulkConvertBoxesInTaskToPolygons,
  bulkConvertBoxesOnFrameToPolygonsWithToast,
} from "@/lib/bulkConvert";
import { annotationsApi, type AnnotationRaw } from "@/api/annotations";
import { samApi } from "@/api/sam";
import { modelsApi } from "@/api/phase2";
import { useAnnotations, type AnnotationDraft } from "@/state/annotations";

vi.mock("@/lib/toast", () => ({ showToast: vi.fn() }));

const TRI: [number, number][] = [[1, 1], [9, 1], [5, 9]];

function rawBox(id: string, asset: string, x = 0): AnnotationRaw {
  return {
    id, asset_id: asset, frame_id: `${asset}-f`, class_id: "c", kind: "bbox",
    geometry: { kind: "bbox", x, y: 0, w: 10, h: 10 }, created_at: "2026-10-10T00:00:00Z",
  };
}

function draft(tempId: string, kind: "bbox" | "polygon", frameId = "f1"): AnnotationDraft {
  return {
    tempId, classId: "c", kind,
    geometry: (kind === "bbox" ? { kind: "bbox", x: 10, y: 20, w: 30, h: 40 } : { kind: "polygon", points: TRI }) as never,
    frameId, serverId: `s-${tempId}`, dirty: false, zOrder: 0, status: "proposed",
    reviewedById: null, reviewedAt: null, prevGeometry: null,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(modelsApi, "samStatus").mockResolvedValue({ state: "ready" } as never);
  useAnnotations.setState({ byId: {} } as never);
});

describe("boxes on the open image", () => {
  it("sends every box in one call and turns them into polygons", async () => {
    useAnnotations.setState({
      byId: { a: draft("a", "bbox"), b: draft("b", "bbox"), p: draft("p", "polygon"), o: draft("o", "bbox", "other") },
    } as never);
    const call = vi.spyOn(samApi, "boxesToPolygons").mockResolvedValue({
      image_hash: "h", encodes: 2, ms: 10,
      results: [{ polygon: TRI, score: 0.9, zoomed: true }, null],
    });
    const res = await bulkConvertBoxesOnFrameToPolygonsWithToast("asset-1", "f1");
    expect(call).toHaveBeenCalledTimes(1);
    const [assetId, body] = call.mock.calls[0];
    expect(assetId).toBe("asset-1");
    expect(body.boxes).toEqual([[10, 20, 40, 60], [10, 20, 40, 60]]);
    expect(body.zoom).toBe(true);
    // One became a polygon (marked for saving); SAM found nothing in the
    // other, so it stays a box. Other frames are untouched.
    const s = useAnnotations.getState().byId;
    expect(s.a.kind).toBe("polygon");
    expect(s.a.dirty).toBe(true);
    expect(s.b.kind).toBe("bbox");
    expect(s.o.kind).toBe("bbox");
    expect(res).toEqual({ converted: 1, skipped: 1 });
  });

  it("sends ground and crowd boxes in their mode and saves them as masks", async () => {
    const ground = { ...draft("g", "bbox"), classId: "cls-ground" };
    useAnnotations.setState({ byId: { a: draft("a", "bbox"), g: ground } } as never);
    const call = vi.spyOn(samApi, "boxesToPolygons").mockResolvedValue({
      image_hash: "h", encodes: 1, ms: 10,
      results: [
        { polygon: TRI, score: 0.9, zoomed: false },
        { polygon: [], score: 1, zoomed: false, mask: { counts: "0,4,12", size: [4, 4] } },
      ],
    });
    await bulkConvertBoxesOnFrameToPolygonsWithToast("asset-1", "f1", { "cls-ground": "ground_surface", c: "person" });
    expect(call.mock.calls[0][1].modes).toEqual(["object", "ground"]);
    const g = useAnnotations.getState().byId.g;
    expect(g.kind).toBe("mask");
    expect(g.geometry).toEqual({ kind: "mask_rle", size: [4, 4], counts: "0,4,12" });
  });
});

describe("touching crowd boxes", () => {
  it("removes the crowd boxes SAM joined into another, on the open image", async () => {
    useAnnotations.setState({ byId: { a: draft("a", "bbox"), b: draft("b", "bbox") } } as never);
    vi.spyOn(samApi, "boxesToPolygons").mockResolvedValue({
      image_hash: "h", encodes: 1, ms: 5,
      results: [
        { polygon: [], score: 1, zoomed: false, mask: { counts: "0,4,12", size: [4, 4] } },
        { polygon: [], score: 1, zoomed: false, mask: null, merged_into: 0 },
      ],
    });
    const res = await bulkConvertBoxesOnFrameToPolygonsWithToast("asset-1", "f1", { c: "crowd" });
    const s = useAnnotations.getState().byId;
    expect(s.a.kind).toBe("mask");
    expect(s.b).toBeUndefined();
    expect(res).toEqual({ converted: 2, skipped: 0 });
  });

  it("deletes them in the task-wide run's batch", async () => {
    vi.spyOn(samApi, "boxesToPolygons").mockResolvedValue({
      image_hash: "h", encodes: 1, ms: 5,
      results: [
        { polygon: [], score: 1, zoomed: false, mask: { counts: "0,4,12", size: [4, 4] } },
        { polygon: [], score: 1, zoomed: false, merged_into: 0 },
      ],
    });
    const batch = vi.spyOn(annotationsApi, "batch").mockResolvedValue({ created: [], updated: [], deleted: ["2"] } as never);
    const res = await bulkConvertBoxesInTaskToPolygons("t1", [rawBox("1", "A"), rawBox("2", "A", 20)]);
    expect(batch.mock.calls[0][1].delete).toEqual(["2"]);
    expect(batch.mock.calls[0][1].update.map((u) => u.id)).toEqual(["1"]);
    expect(res.converted).toBe(2);
  });
});

describe("boxes across the task", () => {
  it("goes image by image and saves each image's polygons", async () => {
    const call = vi.spyOn(samApi, "boxesToPolygons").mockImplementation(async (_a, body) => ({
      image_hash: "h", encodes: 1, ms: 5,
      results: body.boxes.map(() => ({ polygon: TRI, score: 0.9, zoomed: false })),
    }));
    const batch = vi.spyOn(annotationsApi, "batch").mockImplementation(async (_t, body) => ({
      created: [], deleted: [],
      updated: body.update.map((u) => ({ ...rawBox(u.id, "x"), kind: "polygon", geometry: u.geometry })),
    }) as never);
    const seen: number[] = [];
    const res = await bulkConvertBoxesInTaskToPolygons(
      "t1",
      [rawBox("1", "A"), rawBox("2", "A", 20), rawBox("3", "B")],
      { onProgress: (p) => seen.push(p.doneImages) },
    );
    expect(call).toHaveBeenCalledTimes(2);  // one call per image, all its boxes
    expect(call.mock.calls[0][1].boxes).toHaveLength(2);
    expect(call.mock.calls[0][1].frame_id).toBe("A-f");
    expect(batch).toHaveBeenCalledTimes(2);  // saved per image
    expect(res).toMatchObject({ doneImages: 2, totalImages: 2, converted: 3, failedImages: 0, canceled: false });
    expect(seen).toEqual([0, 1, 2]);
  });

  it("stops between images when canceled and counts a failed image", async () => {
    const controller = new AbortController();
    vi.spyOn(samApi, "boxesToPolygons").mockImplementation(async (assetId, body) => {
      if (assetId === "A") throw new Error("model down");
      controller.abort();
      return { image_hash: "h", encodes: 1, ms: 5, results: body.boxes.map(() => ({ polygon: TRI, score: 1, zoomed: false })) };
    });
    vi.spyOn(annotationsApi, "batch").mockResolvedValue({ created: [], updated: [], deleted: [] } as never);
    const res = await bulkConvertBoxesInTaskToPolygons(
      "t1", [rawBox("1", "A"), rawBox("2", "B"), rawBox("3", "C")], { signal: controller.signal },
    );
    expect(res.failedImages).toBe(1);
    expect(res.doneImages).toBe(2);
    expect(res.canceled).toBe(true);
  });
});


describe("modes by class", () => {
  it("maps the spec's classes to how SAM shapes them", async () => {
    const { samModeForClass } = await import("@/lib/samConvert");
    expect(samModeForClass("board_static")).toBe("flat");
    expect(samModeForClass("sail")).toBe("flat");
    expect(samModeForClass("glass_wall")).toBe("carrier");
    expect(samModeForClass("goal_net_frame")).toBe("net");
    expect(samModeForClass("ring_ropes_cage")).toBe("ropes");
    expect(samModeForClass("bicycle")).toBe("object");
    expect(samModeForClass("ground_surface")).toBe("ground");
    expect(samModeForClass("crowd")).toBe("crowd");
    expect(samModeForClass("graphic_overlay")).toBe("overlay");
    expect(samModeForClass("Logo")).toBe("object");
  });
});
