import { describe, expect, it, beforeEach } from "vitest";
import { useAnnotations } from "@/state/annotations";
import { TagTool } from "@/canvas/tools/TagTool";

describe("TagTool", () => {
  beforeEach(() => useAnnotations.getState().reset([]));

  it("adds a tag annotation for the active class", () => {
    let n = 0;
    const tool = new TagTool(() => "c-1", () => "f-1", () => `t-${++n}`);
    expect(tool.apply()).toBe(true);
    const drafts = Object.values(useAnnotations.getState().byId);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe("tag");
    expect(drafts[0].classId).toBe("c-1");
    expect(drafts[0].frameId).toBe("f-1");
  });

  it("is idempotent for the same class+frame", () => {
    let n = 0;
    const tool = new TagTool(() => "c-1", () => "f-1", () => `t-${++n}`);
    tool.apply();
    expect(tool.apply()).toBe(false);
    expect(Object.keys(useAnnotations.getState().byId)).toHaveLength(1);
  });

  it("returns false when no active class", () => {
    const tool = new TagTool(() => null, () => "f-1");
    expect(tool.apply()).toBe(false);
    expect(Object.keys(useAnnotations.getState().byId)).toHaveLength(0);
  });
});
