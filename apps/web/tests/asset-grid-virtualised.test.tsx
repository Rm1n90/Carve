import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/assets", () => ({
  assetsApi: {
    listPage: vi.fn(),
    count: vi.fn(),
    listForTask: vi.fn(),
    upload: vi.fn(),
    uploadZip: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    params,
    className,
    "data-testid": testId,
    "data-active": dataActive,
  }: {
    children: React.ReactNode;
    to?: string;
    params?: { assetId: string };
    className?: string;
    "data-testid"?: string;
    "data-active"?: string;
  }) => (
    <a
      href={`/asset/${params?.assetId ?? "#"}`}
      data-link-asset={params?.assetId}
      data-testid={testId}
      data-active={dataActive}
      className={className}
    >
      {children}
    </a>
  ),
  // Plan 14 Phase 8 Task 3 — the strip now uses ``useNavigate`` for the
  // jump-to feature. Mock returns a no-op navigate.
  useNavigate: () => vi.fn(),
}));

import { assetsApi, type Asset } from "@/api/assets";
import { AssetThumbnailStrip } from "@/components/annotation/AssetThumbnailStrip";

const TOTAL = 10_000;
const PAGE_SIZE = 200;

function makeAsset(i: number): Asset {
  return {
    id: `a-${i}`,
    task_id: "t-1",
    kind: "image",
    xxh3_128: `hash-${i}`,
    mime: "image/png",
    size_bytes: 100,
    width: 200,
    height: 200,
    frames: 1,
    original_name: `image-${i}.png`,
    created_at: "2026-04-26T00:00:00Z",
    thumbnail_url: `https://fake/thumb-${i}.jpg`,
  };
}

function mockListPage() {
  (assetsApi.listPage as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (
      _taskId: string,
      params: { limit?: number; offset?: number } = {},
    ) => {
      const offset = params.offset ?? 0;
      const limit = params.limit ?? PAGE_SIZE;
      const end = Math.min(offset + limit, TOTAL);
      const items = Array.from({ length: end - offset }, (_, i) =>
        makeAsset(offset + i),
      );
      return { items, total: TOTAL, limit, offset };
    },
  );
  // ThumbItem fires a per-asset detail query; returning the real-shape
  // payload keeps the component happy while we exercise virtualisation.
  (assetsApi.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (assetId: string) => ({
      asset: makeAsset(Number(assetId.replace("a-", ""))),
      url: `https://fake/full-${assetId}.png`,
      frame_id: null,
    }),
  );
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

const STRIP_CLIENT_WIDTH = 1200;
const STRIP_CLIENT_HEIGHT = 64;

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom returns 0 for layout properties; @tanstack/react-virtual
  // needs a non-zero size to compute the visible window.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return STRIP_CLIENT_WIDTH;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return STRIP_CLIENT_HEIGHT;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value() {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: STRIP_CLIENT_WIDTH,
        bottom: STRIP_CLIENT_HEIGHT,
        width: STRIP_CLIENT_WIDTH,
        height: STRIP_CLIENT_HEIGHT,
        toJSON() {
          return {};
        },
      } as DOMRect;
    },
  });
});

describe("AssetThumbnailStrip virtualisation", () => {
  it("mounts only the visible window of tiles even with 10 000 assets", async () => {
    mockListPage();

    const { container } = render(
      wrap(
        <AssetThumbnailStrip
          taskId="t-1"
          projectId="p-1"
          activeAssetId="a-0"
        />,
      ),
    );

    const strip = await waitFor(() => {
      const el = container.querySelector(
        '[data-testid="asset-thumbnail-strip"]',
      );
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });

    expect(strip.getAttribute("data-asset-count")).toBe(String(TOTAL));

    // Only the visible window + small overscan should be mounted.
    // Visible (~15 tiles at 88px in a 1200px viewport) + overscan (6
    // each side) lands well under the 60-tile budget the spec calls
    // for. Loosely bounded above to keep this test resilient to small
    // overscan tweaks.
    await waitFor(() => {
      const tiles = container.querySelectorAll(
        '[data-testid^="thumb-a-"], [data-testid^="thumb-skeleton-"]',
      );
      expect(tiles.length).toBeGreaterThan(0);
      expect(tiles.length).toBeLessThanOrEqual(60);
    });

    const tiles = container.querySelectorAll(
      '[data-testid^="thumb-a-"], [data-testid^="thumb-skeleton-"]',
    );
    // Sanity: nowhere near the 10 000 total.
    expect(tiles.length).toBeLessThan(TOTAL / 100);
  });

  it("fetches the next page when the user scrolls past ~80% of the loaded range", async () => {
    mockListPage();

    const { container } = render(
      wrap(
        <AssetThumbnailStrip
          taskId="t-1"
          projectId="p-1"
          activeAssetId="a-0"
        />,
      ),
    );

    // Wait for the initial offset=0 page to land.
    await waitFor(() => {
      expect(assetsApi.listPage).toHaveBeenCalled();
      const offsets = (
        assetsApi.listPage as unknown as ReturnType<typeof vi.fn>
      ).mock.calls.map((c) => c[1]?.offset);
      expect(offsets).toContain(0);
    });

    const strip = await waitFor(() => {
      const el = container.querySelector(
        '[data-testid="asset-thumbnail-strip"]',
      );
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });

    // Drive scrollLeft past ~80% of the loaded 200-tile range. With
    // tiles at 88px wide, 200 tiles span 17 600px and 80% is 14 080px.
    act(() => {
      Object.defineProperty(strip, "scrollLeft", {
        configurable: true,
        value: 15_000,
      });
      strip.dispatchEvent(new Event("scroll"));
    });

    await waitFor(
      () => {
        const offsets = (
          assetsApi.listPage as unknown as ReturnType<typeof vi.fn>
        ).mock.calls.map((c) => c[1]?.offset);
        // The second page lands at offset === PAGE_SIZE.
        expect(offsets).toContain(PAGE_SIZE);
      },
      { timeout: 2000 },
    );
  });
});
