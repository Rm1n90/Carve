import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { samApi } from "@/api/sam";
import { api } from "@/api/client";

describe("samApi visual prompt", () => {
  let postSpy: any;
  let getSpy: any;

  beforeEach(() => {
    postSpy = vi.spyOn(api, "post");
    getSpy = vi.spyOn(api, "get");
  });

  afterEach(() => {
    postSpy.mockRestore();
    getSpy.mockRestore();
  });

  it("autoVisual posts to /assets/:id/sam/auto-visual", async () => {
    postSpy.mockResolvedValue({
      data: { annotations_created: 2, per_class: { class_1: 2 } },
    });
    await samApi.autoVisual("asset-1", {
      sources: [
        {
          asset_id: "src-1",
          groups: [
            {
              class_id: "c1",
              refs: [{ kind: "bbox", xyxy: [0, 0, 10, 10] }],
            },
          ],
        },
      ],
      ref_kind: "bbox",
      threshold: 0.4,
      find_all: true,
      overwrite: false,
    });
    expect(postSpy).toHaveBeenCalledWith(
      "/assets/asset-1/sam/auto-visual",
      expect.objectContaining({ ref_kind: "bbox" }),
    );
  });

  it("autoVisualBatch posts to /tasks/:id/sam/auto-visual-batch", async () => {
    postSpy.mockResolvedValue({ data: { job_id: "j1" } });
    const out = await samApi.autoVisualBatch("task-1", {
      sources: [
        {
          asset_id: "src-1",
          groups: [
            {
              class_id: "c1",
              refs: [
                { kind: "polygon", points: [[0, 0], [1, 0], [1, 1]] },
              ],
            },
          ],
        },
      ],
      ref_kind: "polygon",
      threshold: 0.5,
      find_all: false,
      overwrite: true,
    });
    expect(out.job_id).toBe("j1");
    expect(postSpy).toHaveBeenCalledWith(
      "/tasks/task-1/sam/auto-visual-batch",
      expect.objectContaining({ ref_kind: "polygon" }),
    );
  });

  it("autoVisualBatchProgress GETs the progress endpoint", async () => {
    getSpy.mockResolvedValue({
      data: {
        status: "running",
        done: 1,
        total: 2,
        failed: 0,
        errors: [],
        total_annotations_created: 5,
      },
    });
    const out = await samApi.autoVisualBatchProgress("task-1", "job-1");
    expect(out.done).toBe(1);
    expect(getSpy).toHaveBeenCalledWith(
      "/tasks/task-1/sam/auto-visual-batch/job-1",
    );
  });

  it("autoVisualBatchCancel POSTs the cancel endpoint", async () => {
    postSpy.mockResolvedValue({
      data: { job_id: "j1", status: "canceled" },
    });
    await samApi.autoVisualBatchCancel("task-1", "j1");
    expect(postSpy).toHaveBeenCalledWith(
      "/tasks/task-1/sam/auto-visual-batch/j1/cancel",
    );
  });
});
