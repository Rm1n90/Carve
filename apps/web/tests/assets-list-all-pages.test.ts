// Armin Mehri — mehri.armin@gmail.com
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { assetsApi, type Asset } from "@/api/assets";
import { api } from "@/api/client";

/**
 * Regression: `listForTask` used to issue a single `limit=5000` request,
 * so a task with more than 5000 assets silently lost the tail — the
 * editor's prev/next nav, auto-annotate, YOLOE and the toolbar all acted
 * as if those assets did not exist. It must now walk the offset cursor
 * until it has every row.
 */
describe("assetsApi.listForTask pagination", () => {
  let getSpy: any;

  const makeAsset = (i: number): Asset =>
    ({
      id: `a-${i}`,
      task_id: "t1",
      kind: "image",
      xxh3_128: `h${i}`,
      mime: "image/png",
      size_bytes: 1,
      width: 1,
      height: 1,
      frames: 1,
      original_name: `${i}.png`,
      created_at: "2026-01-01T00:00:00Z",
      thumbnail_url: null,
    }) as Asset;

  beforeEach(() => {
    getSpy = vi.spyOn(api, "get");
  });

  afterEach(() => {
    getSpy.mockRestore();
  });

  it("returns all 9000 assets across multiple pages", async () => {
    const TOTAL = 9000;
    getSpy.mockImplementation(async (url: string) => {
      const params = new URLSearchParams(url.split("?")[1] ?? "");
      const limit = Number(params.get("limit"));
      const offset = Number(params.get("offset"));
      const items = Array.from(
        { length: Math.max(0, Math.min(limit, TOTAL - offset)) },
        (_, k) => makeAsset(offset + k),
      );
      return { data: { items, total: TOTAL, limit, offset } };
    });

    const all = await assetsApi.listForTask("t1");

    expect(all).toHaveLength(TOTAL);
    expect(all[0].id).toBe("a-0");
    expect(all[TOTAL - 1].id).toBe(`a-${TOTAL - 1}`);
    expect(getSpy.mock.calls.length).toBeGreaterThan(1);
  });

  it("stops on an empty page even if total is stale", async () => {
    // Assets deleted mid-walk: the server reports a total the rows can
    // no longer satisfy. The walk must terminate, not spin.
    getSpy.mockImplementation(async (url: string) => {
      const params = new URLSearchParams(url.split("?")[1] ?? "");
      const offset = Number(params.get("offset"));
      const items = offset === 0 ? [makeAsset(0)] : [];
      return { data: { items, total: 9999, limit: 2000, offset } };
    });

    const all = await assetsApi.listForTask("t1");

    expect(all).toHaveLength(1);
    expect(getSpy.mock.calls.length).toBe(2);
  });

  it("issues a single request when the task fits in one page", async () => {
    getSpy.mockResolvedValue({
      data: { items: [makeAsset(0), makeAsset(1)], total: 2, limit: 2000, offset: 0 },
    });

    const all = await assetsApi.listForTask("t1");

    expect(all).toHaveLength(2);
    expect(getSpy).toHaveBeenCalledTimes(1);
  });
});
