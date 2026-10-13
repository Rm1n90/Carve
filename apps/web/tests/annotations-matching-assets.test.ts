// Armin Mehri — mehri.armin@gmail.com
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import { annotationsApi } from "@/api/annotations";
import type { FilterGroup } from "@/lib/annotation-filter";

afterEach(() => vi.restoreAllMocks());

describe("annotationsApi.matchingAssetIds", () => {
  it("asks the server, sending the filter tree as it is", async () => {
    const post = vi
      .spyOn(api, "post")
      .mockResolvedValue({ data: { asset_ids: ["a1", "a7"] } } as never);
    const get = vi.spyOn(api, "get");
    const filter: FilterGroup = {
      combinator: "AND",
      rules: [{ not: false, field: "label", op: "==", value: "backdrop" }],
    };

    const ids = await annotationsApi.matchingAssetIds("t1", filter);

    expect(ids).toEqual(["a1", "a7"]);
    expect(post).toHaveBeenCalledWith("/tasks/t1/annotations:matching-assets", { filter });
    // Never the whole task's annotations.
    expect(get).not.toHaveBeenCalled();
  });
});
