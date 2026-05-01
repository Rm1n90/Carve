import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, type CSSProperties, type WheelEvent } from "react";
import { assetsApi, type Asset, type AssetListPage } from "@/api/assets";
import { cn } from "@/lib/cn";

interface Props {
  taskId: string;
  projectId: string;
  activeAssetId: string;
}

// v3.9 Plan 09 Task 8: switched from a single eager `listForTask` query +
// CSS-only scrolling (which mounted every <Link> tile, even off-screen)
// to a virtualised horizontal list backed by `useInfiniteQuery`. At
// 10 000 assets the previous implementation froze the editor on first
// load. We now mount only the visible tiles + a small overscan, and we
// fetch in 200-asset pages. Scrolling past ~80% of the loaded range
// triggers the next page fetch.
const PAGE_SIZE = 200;
const TILE_WIDTH = 80; // matches w-[80px] below
const TILE_GAP = 8; // 0.5rem inter-tile gap
const TILE_TOTAL = TILE_WIDTH + TILE_GAP;
const OVERSCAN = 6;
const PREFETCH_THRESHOLD = 0.8;

function ThumbItem({
  asset,
  projectId,
  taskId,
  active,
}: {
  asset: Asset;
  projectId: string;
  taskId: string;
  active: boolean;
}) {
  const q = useQuery({
    queryKey: ["asset", asset.id],
    queryFn: () => assetsApi.get(asset.id),
    staleTime: 60_000,
  });

  const url = q.data?.url ?? asset.thumbnail_url ?? null;

  return (
    <Link
      to="/projects/$projectId/tasks/$taskId/assets/$assetId"
      params={{ projectId, taskId, assetId: asset.id }}
      className={cn(
        "shrink-0 block h-[56px] w-[80px] rounded-[var(--radius-sm)] border overflow-hidden",
        "bg-[var(--bg-subtle)] transition-all duration-150",
        active
          ? "border-[var(--accent)] outline-2 outline-offset-1 outline-[var(--accent)]"
          : "border-[var(--border-subtle)] hover:border-[var(--border-strong)]",
      )}
      aria-label={`Open ${asset.original_name}`}
      data-testid={`thumb-${asset.id}`}
      data-active={active ? "true" : undefined}
    >
      {url ? (
        <img
          src={url}
          alt={asset.original_name}
          loading="lazy"
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
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

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
  // The virtualizer needs the full row count so the scroll surface is
  // sized correctly even when only the first page is loaded. Indices
  // beyond `assets.length` render an empty placeholder until their
  // page fetches in.
  const virtualCount = total > 0 ? total : assets.length;

  const virtualizer = useVirtualizer({
    horizontal: true,
    count: virtualCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TILE_TOTAL,
    overscan: OVERSCAN,
  });

  const items = virtualizer.getVirtualItems();
  const lastVisibleIndex = items.length > 0 ? items[items.length - 1].index : 0;

  // When the user has scrolled past ~80% of the *fetched* range, kick
  // off the next page. Compare the last visible virtual index against
  // the loaded count (not total) so a new request only fires when more
  // rows are actually waiting on the server.
  useEffect(() => {
    if (assets.length === 0) return;
    if (!pagesQ.hasNextPage || pagesQ.isFetchingNextPage) return;
    if (lastVisibleIndex >= assets.length * PREFETCH_THRESHOLD) {
      pagesQ.fetchNextPage();
    }
  }, [
    lastVisibleIndex,
    assets.length,
    pagesQ.hasNextPage,
    pagesQ.isFetchingNextPage,
    pagesQ,
  ]);

  const onWheel = useCallback((e: WheelEvent<HTMLDivElement>) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.currentTarget.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, []);

  if (virtualCount <= 1) return null;

  return (
    <div
      ref={scrollRef}
      role="region"
      aria-label="Task thumbnails"
      data-testid="asset-thumbnail-strip"
      data-asset-count={virtualCount}
      onWheel={onWheel}
      className={cn(
        "h-[64px] shrink-0 border-b border-[var(--border-subtle)]",
        "bg-[var(--bg-app)] flex items-center px-3 overflow-x-auto overflow-y-hidden",
      )}
    >
      <div
        style={{
          width: `${virtualizer.getTotalSize()}px`,
          height: "56px",
          position: "relative",
        }}
      >
        {items.map((virtualItem) => {
          const asset = assets[virtualItem.index];
          const style: CSSProperties = {
            position: "absolute",
            top: 0,
            left: 0,
            width: `${TILE_WIDTH}px`,
            height: "56px",
            transform: `translateX(${virtualItem.start}px)`,
          };
          if (!asset) {
            return (
              <div
                key={`pending-${virtualItem.index}`}
                data-testid={`thumb-skeleton-${virtualItem.index}`}
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
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
