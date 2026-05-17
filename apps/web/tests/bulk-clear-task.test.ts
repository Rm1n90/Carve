// Armin Mehri — mehri.armin@gmail.com
//
// v3.31 — verifies the task-wide CLEAR helper sends a single batch
// delete with every annotation id AND removes the locally-mounted
// drafts whose serverId is in the deleted set. Both behaviours are
// observable side-effects the editor relies on for the "Clear in all
// assets" dropdown — without local store sync the just-cleared
// annotations would linger on the open asset until a refetch.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bulkClearTaskAnnotationsWithToast } from "@/lib/bulkConvert";
import { annotationsApi, type AnnotationRaw } from "@/api/annotations";
import { useAnnotations, type AnnotationDraft } from "@/state/annotations";

function rawAnn(id: string): AnnotationRaw {
  return {
    id,
    asset_id: null,
    frame_id: null,
    class_id: "cls-1",
    kind: "bbox",
    geometry: { kind: "bbox", x: 0, y: 0, w: 10, h: 10 },
    created_at: "2026-05-17T15:00:00Z",
    status: "proposed",
  };
}

function draft(tempId: string, serverId: string | null): AnnotationDraft {
  return {
    tempId,
    classId: "cls-1",
    kind: "bbox",
    geometry: { kind: "bbox", x: 0, y: 0, w: 10, h: 10 } as never,
    frameId: null,
    serverId,
    dirty: false,
    zOrder: 0,
    status: "proposed",
    reviewedById: null,
    reviewedAt: null,
    prevGeometry: null,
  };
}

describe("bulkClearTaskAnnotationsWithToast", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAnnotations.setState({ byId: {} } as never);
  });

  it("returns {0,0} when there are no annotations to clear", async () => {
    const batchSpy = vi
      .spyOn(annotationsApi, "batch")
      .mockResolvedValue({ created: [], updated: [], deleted: [] } as never);
    const result = await bulkClearTaskAnnotationsWithToast("task-1", []);
    expect(result).toEqual({ converted: 0, skipped: 0 });
    expect(batchSpy).not.toHaveBeenCalled();
  });

  it("sends every annotation id as a single batch delete", async () => {
    const batchSpy = vi
      .spyOn(annotationsApi, "batch")
      .mockResolvedValue({ created: [], updated: [], deleted: [] } as never);
    const anns = ["a", "b", "c"].map(rawAnn);
    const result = await bulkClearTaskAnnotationsWithToast("task-1", anns);
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(batchSpy).toHaveBeenCalledWith("task-1", {
      create: [],
      update: [],
      delete: ["a", "b", "c"],
    });
    expect(result).toEqual({ converted: 3, skipped: 0 });
  });

  it("removes locally-mounted drafts whose serverId is in the deleted set", async () => {
    vi.spyOn(annotationsApi, "batch").mockResolvedValue({
      created: [],
      updated: [],
      deleted: [],
    } as never);
    useAnnotations.setState({
      byId: {
        "draft-1": draft("draft-1", "srv-1"),
        "draft-2": draft("draft-2", "srv-2"),
        // Unsaved local draft (no serverId) — must NOT be removed.
        "draft-3": draft("draft-3", null),
      },
    } as never);

    await bulkClearTaskAnnotationsWithToast("task-1", [
      rawAnn("srv-1"),
      rawAnn("srv-2"),
    ]);

    const left = Object.keys(useAnnotations.getState().byId);
    expect(left).toEqual(["draft-3"]);
  });

  it("reports skipped=N when the server batch call fails", async () => {
    vi.spyOn(annotationsApi, "batch").mockRejectedValue(new Error("network"));
    const result = await bulkClearTaskAnnotationsWithToast("task-1", [
      rawAnn("a"),
      rawAnn("b"),
    ]);
    expect(result).toEqual({ converted: 0, skipped: 2 });
  });
});
