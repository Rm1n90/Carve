import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
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
  }: {
    children: React.ReactNode;
    to?: string;
    params?: { assetId: string };
    className?: string;
  }) => (
    <a
      href={`/asset/${params?.assetId ?? "#"}`}
      data-link-asset={params?.assetId}
    >
      {children}
    </a>
  ),
}));

import { assetsApi } from "@/api/assets";
import { AssetGrid } from "@/pages/AssetGrid";

interface FakeAsset {
  id: string;
  task_id: string;
  kind: "image";
  xxh3_128: string;
  mime: string;
  size_bytes: number;
  width: number;
  height: number;
  frames: number;
  original_name: string;
  created_at: string;
  thumbnail_url: string;
}

function makeAsset(i: number): FakeAsset {
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
    created_at: "2026-04-26",
    thumbnail_url: `https://fake/thumb-${i}.jpg`,
  };
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("v3.1 Issue 7 — AssetGrid layout is deterministic across navigations", () => {
  it("uses CSS auto-fill grid template (no JS-measured columns state)", async () => {
    const items = Array.from({ length: 12 }, (_, i) => makeAsset(i));
    (assetsApi.count as any).mockResolvedValue({
      total: 12,
      annotated: 0,
      unannotated: 12,
    });
    (assetsApi.listPage as any).mockResolvedValue({
      items,
      total: 12,
      limit: 100,
      offset: 0,
    });

    const { container } = render(
      wrap(<AssetGrid projectId="p1" taskId="t1" />),
    );

    const grid = await waitFor(() => {
      const el = container.querySelector(
        '[data-testid="asset-grid"]',
      ) as HTMLDivElement | null;
      expect(el).toBeTruthy();
      return el!;
    });

    // The grid template must be deterministic CSS, not a JS-derived
    // `repeat(N, ...)` that depends on ResizeObserver timing.
    const tmpl = grid.style.gridTemplateColumns;
    expect(tmpl).toContain("auto-fill");
    expect(tmpl).toContain("minmax(140px,");
    expect(tmpl).not.toMatch(/repeat\(\d+,/); // no fixed column count
  });

  it("renders the filename overlay on every tile", async () => {
    const items = Array.from({ length: 12 }, (_, i) => makeAsset(i));
    (assetsApi.count as any).mockResolvedValue({
      total: 12,
      annotated: 0,
      unannotated: 12,
    });
    (assetsApi.listPage as any).mockResolvedValue({
      items,
      total: 12,
      limit: 100,
      offset: 0,
    });

    const { container } = render(
      wrap(<AssetGrid projectId="p1" taskId="t1" />),
    );

    // Wait for the loaded grid (the Link mock strips top-level data-testid,
    // so query the inner overlay testid instead).
    await waitFor(() => {
      const overlays = container.querySelectorAll(
        '[data-testid^="asset-tile-name-a-"]',
      );
      expect(overlays.length).toBe(12);
    });

    // Every tile carries the filename overlay (the "consistent like Image #1"
    // requirement from the audit).
    const overlays = container.querySelectorAll(
      '[data-testid^="asset-tile-name-a-"]',
    );
    expect(overlays.length).toBe(12);
    items.forEach((a) => {
      const overlay = container.querySelector(
        `[data-testid="asset-tile-name-${a.id}"]`,
      ) as HTMLElement | null;
      expect(overlay).toBeTruthy();
      expect(overlay!.textContent).toContain(a.original_name);
    });
  });

  it("uses the same grid template for skeleton and loaded states", async () => {
    // Initial pending render: skeleton uses the same auto-fill grid.
    (assetsApi.count as any).mockReturnValue(new Promise(() => {}));
    (assetsApi.listPage as any).mockReturnValue(new Promise(() => {}));

    const { container } = render(
      wrap(<AssetGrid projectId="p1" taskId="t1" />),
    );

    const skeleton = container.querySelector(
      '[data-testid="asset-grid-skeleton"]',
    ) as HTMLDivElement | null;
    expect(skeleton).toBeTruthy();
    expect(skeleton!.style.gridTemplateColumns).toContain("auto-fill");
    expect(skeleton!.style.gridTemplateColumns).toContain("minmax(140px,");
  });
});
