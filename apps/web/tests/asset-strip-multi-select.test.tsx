import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Plan 14 Phase 8 Task 3 — multi-select on the asset thumbnail strip.
 *
 * Covers:
 *   - Cmd/Ctrl-click toggles a single asset in/out of the selection.
 *   - Shift-click selects an inclusive range from the anchor.
 *   - ``Esc`` clears the selection set.
 *   - The bottom action bar appears when selection size > 0.
 *   - ``g`` opens the jump-to prompt input.
 */

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
    onClick,
    className,
    "data-testid": testId,
    "data-active": dataActive,
    "data-selected": dataSelected,
    "aria-label": ariaLabel,
  }: {
    children: React.ReactNode;
    to?: string;
    params?: { assetId: string };
    onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
    className?: string;
    "data-testid"?: string;
    "data-active"?: string;
    "data-selected"?: string;
    "aria-label"?: string;
  }) => (
    <a
      href={`/asset/${params?.assetId ?? "#"}`}
      onClick={onClick}
      data-link-asset={params?.assetId}
      data-testid={testId}
      data-active={dataActive}
      data-selected={dataSelected}
      aria-label={ariaLabel}
      className={className}
    >
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));

import { assetsApi, type Asset } from "@/api/assets";
import { AssetThumbnailStrip } from "@/components/annotation/AssetThumbnailStrip";

const TOTAL = 30;
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
  // Replicate the layout shims from asset-grid-virtualised so the
  // virtualizer mounts a window of tiles in jsdom.
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

async function renderStrip() {
  mockListPage();
  const utils = render(
    wrap(
      <AssetThumbnailStrip
        taskId="t-1"
        projectId="p-1"
        activeAssetId="a-0"
      />,
    ),
  );
  await waitFor(() => {
    expect(
      utils.container.querySelector('[data-testid="asset-thumbnail-strip"]'),
    ).toBeTruthy();
  });
  await waitFor(() => {
    expect(
      utils.container.querySelector('[data-testid="thumb-a-2"]'),
    ).toBeTruthy();
  });
  return utils;
}

describe("AssetThumbnailStrip multi-select", () => {
  it("Cmd-click toggles a thumbnail in and out of the selection", async () => {
    const { container } = await renderStrip();

    const tile = container.querySelector(
      '[data-testid="thumb-a-2"]',
    ) as HTMLElement;
    expect(tile).toBeTruthy();

    fireEvent.click(tile, { metaKey: true });

    await waitFor(() => {
      const strip = container.querySelector(
        '[data-testid="asset-thumbnail-strip"]',
      ) as HTMLElement;
      expect(strip.getAttribute("data-selected-count")).toBe("1");
    });

    expect(tile.getAttribute("data-selected")).toBe("true");

    // Toggling again removes it.
    fireEvent.click(tile, { metaKey: true });
    await waitFor(() => {
      const strip = container.querySelector(
        '[data-testid="asset-thumbnail-strip"]',
      ) as HTMLElement;
      expect(strip.getAttribute("data-selected-count")).toBe("0");
    });
  });

  it("Shift-click extends the selection range from the anchor", async () => {
    const { container } = await renderStrip();

    // First Cmd-click sets the anchor to index 1.
    const anchorTile = container.querySelector(
      '[data-testid="thumb-a-1"]',
    ) as HTMLElement;
    fireEvent.click(anchorTile, { metaKey: true });

    await waitFor(() => {
      const strip = container.querySelector(
        '[data-testid="asset-thumbnail-strip"]',
      ) as HTMLElement;
      expect(strip.getAttribute("data-selected-count")).toBe("1");
    });

    // Shift-click thumb a-4 — expect ids 1..4 (4 entries) to be selected.
    const target = container.querySelector(
      '[data-testid="thumb-a-4"]',
    ) as HTMLElement;
    fireEvent.click(target, { shiftKey: true });

    await waitFor(() => {
      const strip = container.querySelector(
        '[data-testid="asset-thumbnail-strip"]',
      ) as HTMLElement;
      expect(strip.getAttribute("data-selected-count")).toBe("4");
    });
  });

  it("Esc clears the selection set", async () => {
    const { container } = await renderStrip();

    const tile = container.querySelector(
      '[data-testid="thumb-a-2"]',
    ) as HTMLElement;
    fireEvent.click(tile, { metaKey: true });

    await waitFor(() => {
      const strip = container.querySelector(
        '[data-testid="asset-thumbnail-strip"]',
      ) as HTMLElement;
      expect(strip.getAttribute("data-selected-count")).toBe("1");
    });

    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });

    await waitFor(() => {
      const strip = container.querySelector(
        '[data-testid="asset-thumbnail-strip"]',
      ) as HTMLElement;
      expect(strip.getAttribute("data-selected-count")).toBe("0");
    });
  });

  it("the bottom action bar appears when at least one asset is selected", async () => {
    const { container } = await renderStrip();

    expect(
      container.querySelector('[data-testid="asset-strip-multi-select-bar"]'),
    ).toBeNull();

    const tile = container.querySelector(
      '[data-testid="thumb-a-3"]',
    ) as HTMLElement;
    fireEvent.click(tile, { metaKey: true });

    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-testid="asset-strip-multi-select-bar"]',
        ),
      ).toBeTruthy();
    });

    const counter = container.querySelector(
      '[data-testid="asset-strip-multi-select-counter"]',
    );
    expect(counter?.textContent).toMatch(/1 selected/);
  });

  it("pressing 'g' opens the jump-to prompt", async () => {
    const { container } = await renderStrip();

    expect(
      container.querySelector('[data-testid="asset-strip-jump-prompt"]'),
    ).toBeNull();

    act(() => {
      fireEvent.keyDown(document, { key: "g" });
    });

    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="asset-strip-jump-prompt"]'),
      ).toBeTruthy();
    });

    const input = container.querySelector(
      '[data-testid="asset-strip-jump-input"]',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
  });
});
