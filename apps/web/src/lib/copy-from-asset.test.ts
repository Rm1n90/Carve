// Armin Mehri — mehri.armin@gmail.com
import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { copyAnnotationsFromAssetTo } from "./copy-from-asset";
import type { Asset } from "@/api/assets";

interface RawAnno {
  id: string;
  asset_id: string;
  class_id: string;
  kind: "bbox" | "polygon" | "tag" | "mask_rle";
  geometry: unknown;
}

function makeAsset(over: Partial<Asset>): Asset {
  return {
    id: over.id ?? "target",
    task_id: "t1",
    kind: "image",
    xxh3_128: "x",
    mime: "image/png",
    size_bytes: 1,
    width: 1000,
    height: 800,
    frames: 1,
    original_name: over.original_name ?? "target.png",
    created_at: "2026-05-26T00:00:00Z",
    thumbnail_url: null,
    ...over,
  } as Asset;
}

function seedRawQuery(qc: QueryClient, rows: RawAnno[]) {
  qc.setQueryData(["task-annotations-raw", "t1"], rows);
}

describe("copyAnnotationsFromAssetTo", () => {
  it("returns accepted drafts when source has annotations", async () => {
    const qc = new QueryClient();
    seedRawQuery(qc, [
      {
        id: "a1",
        asset_id: "src",
        class_id: "c1",
        kind: "bbox",
        geometry: { kind: "bbox", x: 10, y: 10, w: 200, h: 100 },
      },
    ]);

    const res = await copyAnnotationsFromAssetTo({
      sourceAssetId: "src",
      targetAsset: makeAsset({ id: "target" }),
      taskId: "t1",
      allowedClassIds: null,
      frameId: "f1",
      qc,
    });

    expect(res.sourceTotal).toBe(1);
    expect(res.accepted).toHaveLength(1);
    expect(res.skippedByClass).toBe(0);
    expect(res.skippedByGeometry).toBe(0);
  });

  it("reports zero accepted and surfaces sourceTotal:0 when source has no annotations", async () => {
    const qc = new QueryClient();
    seedRawQuery(qc, []);

    const res = await copyAnnotationsFromAssetTo({
      sourceAssetId: "src",
      targetAsset: makeAsset({ id: "target" }),
      taskId: "t1",
      allowedClassIds: null,
      frameId: null,
      qc,
    });

    expect(res.sourceTotal).toBe(0);
    expect(res.accepted).toHaveLength(0);
  });

  it("rejects when sourceAssetId equals targetAsset.id", async () => {
    const qc = new QueryClient();
    seedRawQuery(qc, []);

    await expect(
      copyAnnotationsFromAssetTo({
        sourceAssetId: "same",
        targetAsset: makeAsset({ id: "same" }),
        taskId: "t1",
        allowedClassIds: null,
        frameId: null,
        qc,
      }),
    ).rejects.toThrowError(/same/i);
  });

  it("respects allowedClassIds whitelist", async () => {
    const qc = new QueryClient();
    seedRawQuery(qc, [
      {
        id: "a1",
        asset_id: "src",
        class_id: "OK",
        kind: "bbox",
        geometry: { kind: "bbox", x: 0, y: 0, w: 100, h: 100 },
      },
      {
        id: "a2",
        asset_id: "src",
        class_id: "BLOCKED",
        kind: "bbox",
        geometry: { kind: "bbox", x: 0, y: 0, w: 100, h: 100 },
      },
    ]);

    const res = await copyAnnotationsFromAssetTo({
      sourceAssetId: "src",
      targetAsset: makeAsset({ id: "target" }),
      taskId: "t1",
      allowedClassIds: new Set(["OK"]),
      frameId: null,
      qc,
    });

    expect(res.accepted).toHaveLength(1);
    expect(res.accepted[0].classId).toBe("OK");
    expect(res.skippedByClass).toBe(1);
  });

  it("rejects when target asset is a video", async () => {
    const qc = new QueryClient();
    seedRawQuery(qc, []);
    await expect(
      copyAnnotationsFromAssetTo({
        sourceAssetId: "src",
        targetAsset: makeAsset({ id: "target", kind: "video" as const }),
        taskId: "t1",
        allowedClassIds: null,
        frameId: null,
        qc,
      }),
    ).rejects.toThrowError(/image-only/i);
  });

  it("fetches the raw query when the cache is cold", async () => {
    const qc = new QueryClient();
    const fetchSpy = vi
      .spyOn(qc, "fetchQuery")
      .mockResolvedValueOnce([] as never);

    await copyAnnotationsFromAssetTo({
      sourceAssetId: "src",
      targetAsset: makeAsset({ id: "target" }),
      taskId: "t1",
      allowedClassIds: null,
      frameId: null,
      qc,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toMatchObject({
      queryKey: ["task-annotations-raw", "t1"],
    });
  });
});
