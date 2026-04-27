import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
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
    <a href={`/asset/${params?.assetId ?? "#"}`} data-link-asset={params?.assetId}>
      {children}
    </a>
  ),
}));

import { assetsApi } from "@/api/assets";
import { AssetGrid } from "@/pages/AssetGrid";

const PAGE_SIZE = 100;

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
  // jsdom returns 0 for layout properties; pretend the grid container is
  // wide so the virtualizer can compute multi-column rows.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return 800;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return 600;
    },
  });
});

describe("AssetGrid virtualization", () => {
  it("does not render anywhere near 10000 tiles when the dataset is huge", async () => {
    const items = Array.from({ length: PAGE_SIZE }, (_, i) => makeAsset(i));
    (assetsApi.count as any).mockResolvedValue({
      total: 10000,
      annotated: 3200,
      unannotated: 6800,
    });
    (assetsApi.listPage as any).mockResolvedValue({
      items,
      total: 10000,
      limit: PAGE_SIZE,
      offset: 0,
    });

    const { container } = render(wrap(<AssetGrid projectId="p1" taskId="t1" />));

    await waitFor(() =>
      expect(container.querySelector('[data-testid="asset-grid-virtual-scroll"]')).toBeTruthy(),
    );

    const tiles = container.querySelectorAll('[data-testid^="asset-tile-"]');
    expect(tiles.length).toBeLessThan(150);
    expect(screen.getByTestId("asset-count-summary").textContent).toContain("10,000");
  });

  it("renders skeleton tiles while the initial fetch is pending", async () => {
    let resolveList: (v: unknown) => void = () => {};
    (assetsApi.count as any).mockReturnValue(new Promise(() => {}));
    (assetsApi.listPage as any).mockReturnValue(
      new Promise((res) => {
        resolveList = res as any;
      }),
    );
    const { container } = render(wrap(<AssetGrid projectId="p1" taskId="t1" />));
    expect(
      container.querySelector('[data-testid="asset-grid-skeleton"]'),
    ).toBeTruthy();
    // Resolve so the test exits cleanly.
    act(() => {
      resolveList({ items: [], total: 0, limit: 100, offset: 0 });
    });
  });

  it("debounces the search input and re-fetches with a q parameter", async () => {
    (assetsApi.count as any).mockResolvedValue({
      total: 0,
      annotated: 0,
      unannotated: 0,
    });
    (assetsApi.listPage as any).mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    });

    render(wrap(<AssetGrid projectId="p1" taskId="t1" />));
    await waitFor(() => expect(assetsApi.listPage).toHaveBeenCalledTimes(1));

    const input = screen.getByTestId("asset-search-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "kitten" } });

    await waitFor(
      () => {
        const last = (assetsApi.listPage as any).mock.calls.at(-1);
        expect(last?.[1]?.q).toBe("kitten");
      },
      { timeout: 1000 },
    );
  });

  it("changes the status query param when clicking a filter chip", async () => {
    (assetsApi.count as any).mockResolvedValue({
      total: 5,
      annotated: 2,
      unannotated: 3,
    });
    (assetsApi.listPage as any).mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    });

    render(wrap(<AssetGrid projectId="p1" taskId="t1" />));
    await waitFor(() => expect(assetsApi.listPage).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId("filter-chip-annotated"));

    await waitFor(() => {
      const last = (assetsApi.listPage as any).mock.calls.at(-1);
      expect(last?.[1]?.status).toBe("annotated");
    });

    fireEvent.click(screen.getByTestId("filter-chip-unannotated"));
    await waitFor(() => {
      const last = (assetsApi.listPage as any).mock.calls.at(-1);
      expect(last?.[1]?.status).toBe("unannotated");
    });
  });
});
