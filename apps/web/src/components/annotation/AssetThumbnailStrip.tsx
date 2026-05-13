// Armin Mehri — mehri.armin@gmail.com
import {
  keepPreviousData,
  useInfiniteQuery,
} from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent,
} from "react";
import {
  ChevronDown,
  ChevronUp,
  FolderInput,
  Images,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { assetsApi, type Asset, type AssetListPage } from "@/api/assets";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/cn";
import { useShortcutHandler } from "@/state/shortcuts";

interface Props {
  taskId: string;
  projectId: string;
  activeAssetId: string;
  /**
   * Plan 14 Phase 8 Task 3 — multi-select bulk actions. Each handler is
   * optional so the host page can wire the ones it has APIs for and
   * leave the rest as visible-but-toast-only affordances.
   */
  onBulkDelete?: (ids: string[]) => void;
  onBulkMove?: (ids: string[]) => void;
  onBulkTag?: (ids: string[]) => void;
}

// v3.9 Plan 09 Task 8: switched from a single eager `listForTask` query +
// CSS-only scrolling (which mounted every <Link> tile, even off-screen)
// to a virtualised horizontal list backed by `useInfiniteQuery`. At
// 10 000 assets the previous implementation froze the editor on first
// load. We now mount only the visible tiles + a small overscan, and we
// fetch in 200-asset pages. Scrolling past ~80% of the loaded range
// triggers the next page fetch.
const PAGE_SIZE = 500;
const TILE_WIDTH = 80; // matches w-[80px] below
const TILE_GAP = 8; // 0.5rem inter-tile gap
const TILE_TOTAL = TILE_WIDTH + TILE_GAP;
// Large overscan so a wide window of tiles is mounted around the
// viewport and arrow-key navigation lands on already-rendered tiles.
const OVERSCAN = 30;

function ThumbItem({
  asset,
  projectId,
  taskId,
  active,
  selected,
  onClick,
}: {
  asset: Asset;
  projectId: string;
  taskId: string;
  active: boolean;
  selected: boolean;
  /**
   * Plan 14 Phase 8 Task 3 — when the host's click handler returns
   * ``true`` it has consumed the click for multi-select; the Link's
   * default navigation must be suppressed.
   */
  onClick: (e: ReactMouseEvent<HTMLAnchorElement>) => boolean;
}) {
  // v3.31 — use the presigned ``thumbnail_url`` the list endpoint
  // already returns for every asset. Previously each tile fired its
  // own ``GET /assets/{id}`` to resolve the same URL, which meant the
  // first screenful of the strip needed dozens of network requests
  // and never came in fast enough for arrow-key navigation to feel
  // smooth. Falling back to the asset's full ``url`` is unnecessary
  // here — image tiles only need the cheaper thumbnail surface.
  const url = asset.thumbnail_url ?? null;

  return (
    <Link
      to="/projects/$projectId/tasks/$taskId/assets/$assetId"
      params={{ projectId, taskId, assetId: asset.id }}
      onClick={(e) => {
        const consumed = onClick(e);
        if (consumed) {
          e.preventDefault();
        }
      }}
      className={cn(
        "shrink-0 block h-[56px] w-[80px] rounded-[var(--radius-sm)] border overflow-hidden",
        "bg-[var(--bg-subtle)] transition-all duration-150",
        active
          ? "border-[var(--accent)] outline-2 outline-offset-1 outline-[var(--accent)]"
          : selected
            ? "border-[var(--accent)] ring-2 ring-[var(--accent)]"
            : "border-[var(--border-subtle)] hover:border-[var(--border-strong)]",
      )}
      aria-label={`Open ${asset.original_name}`}
      data-testid={`thumb-${asset.id}`}
      data-active={active ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
    >
      {url ? (
        <img
          src={url}
          alt={asset.original_name}
          decoding="async"
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="block h-full w-full" aria-hidden />
      )}
    </Link>
  );
}

export function AssetThumbnailStrip({
  taskId,
  projectId,
  activeAssetId,
  onBulkDelete,
  onBulkMove,
  onBulkTag,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();
  // Collapse state persists across sessions so the editor remembers the
  // user's preference without leaking into the global tool store
  // (visibility.thumbnails is the kill switch; this is a UI affordance).
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("asset-strip:collapsed") === "1";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("asset-strip:collapsed", collapsed ? "1" : "0");
  }, [collapsed]);

  // Plan 14 Phase 8 Task 3 — multi-select state. ``selectedAssetIds``
  // survives virtualisation because off-screen tiles unmount but their
  // ids stay in the Set; re-mounted tiles read ``selected`` from the
  // same source of truth.
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(
    () => new Set(),
  );
  // ``anchorIndex`` is the last single-clicked / navigated-to asset.
  // Shift-click expands a range from this index to the target.
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpDraft, setJumpDraft] = useState("");
  const jumpInputRef = useRef<HTMLInputElement | null>(null);

  const pagesQ = useInfiniteQuery({
    queryKey: ["task-assets-strip", taskId],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      assetsApi.listPage(taskId, {
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    getNextPageParam: (lastPage: AssetListPage) => {
      const fetchedSoFar = lastPage.offset + lastPage.items.length;
      return fetchedSoFar < lastPage.total ? fetchedSoFar : undefined;
    },
    placeholderData: keepPreviousData,
  });

  const assets: Asset[] = useMemo(
    () => pagesQ.data?.pages.flatMap((p) => p.items) ?? [],
    [pagesQ.data],
  );

  const total = pagesQ.data?.pages[0]?.total ?? assets.length;
  const virtualCount = total > 0 ? total : assets.length;

  // DOM virtualisation keeps mounted-tile count bounded even for
  // 2000+-asset tasks (the user's typical size). Combined with the
  // background prefetch effect further down — which warms the
  // browser image cache for every asset's thumbnail_url — the
  // visible tiles paint from cache the moment the virtualizer
  // mounts them, so navigation never lands on a blank tile.
  const virtualizer = useVirtualizer({
    horizontal: true,
    count: virtualCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TILE_TOTAL,
    overscan: OVERSCAN,
  });
  const virtualItems = virtualizer.getVirtualItems();

  // Eagerly drain every remaining page once the strip mounts so the
  // virtualizer always has the full asset list and the prefetch
  // effect below can warm the browser cache for every thumbnail.
  // Depending on the boolean ``hasNextPage`` / ``isFetchingNextPage``
  // (not the full ``pagesQ`` object) is critical — the query object
  // changes identity every render, which would make this effect run
  // in a tight loop. The fetchNextPage call itself triggers a
  // re-render with new boolean values, which advances to the next
  // page until ``hasNextPage`` becomes false.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = pagesQ;
  useEffect(() => {
    if (!hasNextPage || isFetchingNextPage) return;
    void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Background image-cache warm-up. For each asset's
  // ``thumbnail_url`` we construct a hidden ``Image`` object whose
  // sole job is to fire the HTTP request; the browser then caches
  // the response. When the virtualizer later mounts the visible
  // ``<img>`` with the same src, the browser serves it from cache
  // instantly. The browser already caps concurrent connections per
  // host (≈6 in Chrome) so 2000+ prefetches don't thunder — they
  // queue and drain in the background while the user works.
  //
  // We dedupe via a ref so URLs already enqueued don't restart on
  // every render, and we walk newly-arrived assets only.
  const prefetchedUrls = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (assets.length === 0) return;
    for (const a of assets) {
      const url = a.thumbnail_url;
      if (!url || prefetchedUrls.current.has(url)) continue;
      prefetchedUrls.current.add(url);
      const img = new Image();
      img.decoding = "async";
      img.src = url;
    }
  }, [assets]);

  const onWheel = useCallback((e: WheelEvent<HTMLDivElement>) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.currentTarget.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, []);

  // Keep the active thumbnail visible. When the user navigates between
  // assets via the arrow keys or the prev/next buttons in the toolbar,
  // the strip's scroll position would otherwise leave the new active
  // tile off-screen — making the strip feel stuck. Re-centre the
  // viewport on the active asset whenever it changes.
  // Stable refs for the re-center effect below. Including ``assets``
  // and ``virtualizer`` in the dep array re-fires this effect every
  // render — and ``behavior: "smooth"`` then queues a new animation
  // on top of the in-flight one, which is exactly why arrow-spamming
  // made the strip feel stuck. Recentre only when the active asset
  // changes, and snap (no smooth animation) so rapid presses always
  // land on the latest tile instantly.
  const assetsRef = useRef(assets);
  assetsRef.current = assets;
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;
  useEffect(() => {
    if (!activeAssetId) return;
    const idx = assetsRef.current.findIndex((a) => a.id === activeAssetId);
    if (idx < 0) return;
    virtualizerRef.current.scrollToIndex(idx, {
      align: "center",
      behavior: "auto",
    });
  }, [activeAssetId]);

  // Plan 14 Phase 8 Task 3 — anchor tracks the active asset whenever
  // the user navigates to a new one, mirroring the spec: "the anchor is
  // the last asset that was navigated to or the last cmd-clicked asset".
  useEffect(() => {
    const idx = assets.findIndex((a) => a.id === activeAssetId);
    if (idx >= 0) {
      setAnchorIndex(idx);
    }
  }, [activeAssetId, assets]);

  const clearSelection = useCallback(() => {
    setSelectedAssetIds(new Set());
  }, []);

  const handleThumbClick = useCallback(
    (index: number, asset: Asset, e: ReactMouseEvent<HTMLAnchorElement>): boolean => {
      // Cmd/Ctrl-click — toggle a single id. Anchor moves to the
      // toggled asset so a subsequent shift-click extends from here.
      if (e.metaKey || e.ctrlKey) {
        setSelectedAssetIds((prev) => {
          const next = new Set(prev);
          if (next.has(asset.id)) {
            next.delete(asset.id);
          } else {
            next.add(asset.id);
          }
          return next;
        });
        setAnchorIndex(index);
        return true;
      }
      // Shift-click — range from anchor (or current index if no anchor).
      if (e.shiftKey) {
        const start = anchorIndex ?? index;
        const [lo, hi] = start <= index ? [start, index] : [index, start];
        const range = new Set<string>();
        for (let i = lo; i <= hi; i++) {
          const a = assets[i];
          if (a) range.add(a.id);
        }
        setSelectedAssetIds((prev) => {
          const next = new Set(prev);
          for (const id of range) next.add(id);
          return next;
        });
        return true;
      }
      // Plain click — let the Link navigate normally; clear any active
      // multi-selection so the user gets a clean slate when jumping
      // back into single-asset edit mode.
      if (selectedAssetIds.size > 0) {
        setSelectedAssetIds(new Set());
      }
      setAnchorIndex(index);
      return false;
    },
    [anchorIndex, assets, selectedAssetIds],
  );

  // Plan 14 Phase 8 Task 3 -- ``Esc`` clears the multi-select set / closes
  // jump-to. Esc stays as an inline system handler (dialog-local).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (selectedAssetIds.size > 0) {
          setSelectedAssetIds(new Set());
          e.preventDefault();
        }
        if (jumpOpen) {
          setJumpOpen(false);
          setJumpDraft("");
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectedAssetIds, jumpOpen]);

  // v3.21 -- "g" opens the jump-to-asset prompt. Customizable via
  // ``group_assets`` in Settings -> Shortcuts.
  useShortcutHandler("group_assets", () => {
    setJumpOpen(true);
    setJumpDraft("");
  });

  useEffect(() => {
    if (jumpOpen) {
      jumpInputRef.current?.focus();
    }
  }, [jumpOpen]);

  const commitJump = useCallback(() => {
    const n = parseInt(jumpDraft, 10);
    setJumpOpen(false);
    setJumpDraft("");
    if (!Number.isFinite(n) || n < 1 || n > virtualCount) return;
    const target = assets[n - 1];
    if (!target) return;
    void navigate({
      to: "/projects/$projectId/tasks/$taskId/assets/$assetId",
      params: { projectId, taskId, assetId: target.id },
    });
  }, [jumpDraft, virtualCount, assets, navigate, projectId, taskId]);

  const selectedCount = selectedAssetIds.size;

  if (virtualCount <= 1) return null;

  if (collapsed) {
    return (
      <div
        role="region"
        aria-label="Task thumbnails (collapsed)"
        data-testid="asset-thumbnail-strip"
        data-collapsed="true"
        data-asset-count={virtualCount}
        className={cn(
          "h-[24px] shrink-0 border-b border-[var(--border-subtle)]",
          "bg-[var(--bg-app)] flex items-center justify-between px-3",
          "text-[11px] text-[color:var(--text-tertiary)]",
        )}
      >
        <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
          <Images className="h-3 w-3" />
          {virtualCount} assets
        </span>
        <button
          type="button"
          aria-label="Expand thumbnail strip"
          data-testid="asset-strip-toggle"
          onClick={() => setCollapsed(false)}
          className={cn(
            "inline-flex items-center gap-1 h-5 px-1.5 rounded-[var(--radius-xs)]",
            "hover:bg-[var(--bg-hover)] text-[color:var(--text-secondary)]",
          )}
        >
          <ChevronUp className="h-3 w-3" />
          <span className="text-[10.5px]">Show thumbnails</span>
        </button>
      </div>
    );
  }

  return (
    <>
      <div
        className={cn(
          "relative h-[64px] shrink-0 border-b border-[var(--border-subtle)]",
          "bg-[var(--bg-app)]",
        )}
      >
      <div
        ref={scrollRef}
        role="region"
        aria-label="Task thumbnails"
        data-testid="asset-thumbnail-strip"
        data-asset-count={virtualCount}
        data-selected-count={selectedCount}
        onWheel={onWheel}
        className={cn(
          "h-full flex items-center pl-3 pr-12 overflow-x-auto overflow-y-hidden",
        )}
      >
        <div
          style={{
            width: `${virtualizer.getTotalSize()}px`,
            height: "56px",
            position: "relative",
          }}
        >
          {virtualItems.map((vi) => {
            const asset = assets[vi.index];
            const style = {
              position: "absolute" as const,
              top: 0,
              left: 0,
              width: `${TILE_WIDTH}px`,
              height: "56px",
              transform: `translateX(${vi.start}px)`,
            };
            if (!asset) {
              return (
                <div
                  key={`pending-${vi.index}`}
                  data-testid={`thumb-skeleton-${vi.index}`}
                  style={style}
                  className="rounded-[var(--radius-sm)] bg-[var(--bg-subtle)] border border-[var(--border-subtle)]"
                  aria-hidden
                />
              );
            }
            return (
              <div key={asset.id} style={style}>
                <ThumbItem
                  asset={asset}
                  projectId={projectId}
                  taskId={taskId}
                  active={asset.id === activeAssetId}
                  selected={selectedAssetIds.has(asset.id)}
                  onClick={(e) => handleThumbClick(vi.index, asset, e)}
                />
              </div>
            );
          })}
        </div>
      </div>
      {/* Collapse toggle — absolute-positioned overlay anchored to the
          right edge of the strip wrapper (NOT inside the horizontal
          scroll container), so it stays put regardless of scroll
          position. The pr-12 padding on the scroll surface reserves
          room so the button never overlaps the rightmost tile. */}
      <button
        type="button"
        aria-label="Collapse thumbnail strip"
        data-testid="asset-strip-toggle"
        onClick={() => setCollapsed(true)}
        className={cn(
          "absolute right-2 top-1/2 -translate-y-1/2 z-10",
          "h-7 w-7 grid place-items-center rounded-[var(--radius-sm)]",
          "bg-[var(--bg-app)]/95 backdrop-blur-sm",
          "text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)] hover:bg-[var(--bg-hover)]",
          "border border-[var(--border-subtle)]",
        )}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      </div>

      {/* Plan 14 Phase 8 Task 3 — bottom-center multi-select action bar. */}
      {selectedCount > 0 && (
        <div
          data-testid="asset-strip-multi-select-bar"
          role="toolbar"
          aria-label="Bulk asset actions"
          className={cn(
            "fixed left-1/2 bottom-6 -translate-x-1/2 z-50",
            "flex items-center gap-1 px-2 py-1.5",
            "rounded-[var(--radius-md)] border border-[var(--border-subtle)]",
            "bg-[var(--bg-elev)] shadow-lg",
            "text-[12.5px] text-[color:var(--text-primary)]",
          )}
        >
          <span
            data-testid="asset-strip-multi-select-counter"
            className="px-2 font-mono tabular-nums text-[color:var(--text-secondary)]"
          >
            {selectedCount} selected
          </span>
          <button
            type="button"
            data-testid="asset-strip-multi-select-delete"
            onClick={() => {
              const ids = Array.from(selectedAssetIds);
              // TODO: wire to assetsApi.delete batch / page-level handler.
              onBulkDelete?.(ids);
            }}
            className="inline-flex items-center gap-1 h-7 px-2 rounded-[var(--radius-sm)] text-[color:var(--danger)] hover:bg-[var(--danger-bg)]"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
          <button
            type="button"
            data-testid="asset-strip-multi-select-move"
            onClick={() => {
              const ids = Array.from(selectedAssetIds);
              // TODO: surface a task-picker dropdown.
              onBulkMove?.(ids);
            }}
            className="inline-flex items-center gap-1 h-7 px-2 rounded-[var(--radius-sm)] hover:bg-[var(--bg-hover)]"
          >
            <FolderInput className="h-3.5 w-3.5" />
            Move to task…
          </button>
          <button
            type="button"
            data-testid="asset-strip-multi-select-tag"
            onClick={() => {
              const ids = Array.from(selectedAssetIds);
              // TODO: surface a tag picker / inline create.
              onBulkTag?.(ids);
            }}
            className="inline-flex items-center gap-1 h-7 px-2 rounded-[var(--radius-sm)] hover:bg-[var(--bg-hover)]"
          >
            <Tag className="h-3.5 w-3.5" />
            Tag…
          </button>
          <button
            type="button"
            data-testid="asset-strip-multi-select-clear"
            onClick={clearSelection}
            aria-label="Clear selection"
            className="inline-flex items-center gap-1 h-7 px-2 rounded-[var(--radius-sm)] text-[color:var(--text-tertiary)] hover:bg-[var(--bg-hover)]"
          >
            <X className="h-3.5 w-3.5" />
            Clear
          </button>
        </div>
      )}

      {/* Plan 14 Phase 8 Task 3 — jump-to prompt. */}
      {jumpOpen && (
        <div
          data-testid="asset-strip-jump-prompt"
          role="dialog"
          aria-label="Go to asset"
          className={cn(
            "fixed left-1/2 top-20 -translate-x-1/2 z-50",
            "flex items-center gap-2 px-3 py-2",
            "rounded-[var(--radius-md)] border border-[var(--border-subtle)]",
            "bg-[var(--bg-elev)] shadow-lg text-[12.5px]",
          )}
        >
          <span className="text-[color:var(--text-tertiary)]">Go to asset</span>
          <Input
            ref={jumpInputRef}
            type="number"
            min={1}
            max={virtualCount}
            value={jumpDraft}
            onChange={(e) => setJumpDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitJump();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setJumpOpen(false);
                setJumpDraft("");
              }
            }}
            data-testid="asset-strip-jump-input"
            aria-label="Asset number"
            className="w-20"
          />
          <span className="font-mono text-[color:var(--text-tertiary)]">
            / {virtualCount}
          </span>
        </div>
      )}
    </>
  );
}
