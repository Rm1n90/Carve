import { useEffect, useMemo, useRef, useState } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Search, Video } from "lucide-react";
import {
  assetsApi,
  type Asset,
  type AssetStatusFilter,
} from "@/api/assets";
import { cn } from "@/lib/cn";

const PAGE_SIZE = 100;
// Tile size is purely CSS-driven via `auto-fill, minmax(...)` so the layout is
// deterministic across navigations and does not depend on JS measurement
// timing (which previously caused a 4-vs-6 column regression — see v3.1 Issue 7).
const TILE_MIN_WIDTH = 140;
const SEARCH_DEBOUNCE_MS = 300;

const GRID_TEMPLATE_COLUMNS = `repeat(auto-fill, minmax(${TILE_MIN_WIDTH}px, 1fr))`;

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

interface AssetTileProps {
  asset: Asset;
  projectId: string;
  taskId: string;
}

function AssetTile({ asset, projectId, taskId }: AssetTileProps) {
  return (
    <Link
      to="/projects/$projectId/tasks/$taskId/assets/$assetId"
      params={{ projectId, taskId, assetId: asset.id }}
      className="group block"
      data-testid={`asset-tile-${asset.id}`}
    >
      <div
        className={cn(
          "relative aspect-square overflow-hidden",
          "rounded-[var(--radius-md)] border border-[var(--border-subtle)]",
          "bg-[var(--bg-sunken)]",
          "transition-all duration-200",
          "group-hover:border-[var(--border-accent)] group-hover:shadow-[0_0_24px_oklch(0.78_0.16_215_/_0.18)]",
        )}
      >
        {asset.kind === "image" && asset.thumbnail_url ? (
          <img
            src={asset.thumbnail_url}
            alt={asset.original_name}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : asset.kind === "video" ? (
          asset.thumbnail_url ? (
            <img
              src={asset.thumbnail_url}
              alt={asset.original_name}
              loading="lazy"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="grid h-full place-items-center text-[color:var(--accent)]">
              <Video className="h-8 w-8" />
            </div>
          )
        ) : (
          <div className="h-full w-full bg-[var(--bg-subtle)]" />
        )}
        {/* Bottom gradient scrim ensures the filename overlay reads on bright
            images (v3.1 Issue 7 — the prior flat backdrop was unreadable). */}
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 h-16",
            "bg-gradient-to-t from-black/70 via-black/40 to-transparent",
          )}
        />
        <div
          data-testid={`asset-tile-name-${asset.id}`}
          className={cn(
            "absolute inset-x-2 bottom-2 px-2 py-1",
            "rounded-[var(--radius-xs)] bg-[oklch(0.06_0.012_240_/_0.85)] backdrop-blur-md",
            "text-[11px] text-secondary truncate",
          )}
        >
          {asset.original_name}
        </div>
      </div>
    </Link>
  );
}

function SkeletonTile() {
  return (
    <div
      className={cn(
        "aspect-square rounded-[var(--radius-md)] border border-[var(--border-subtle)]",
        "bg-[var(--bg-subtle)] animate-pulse",
      )}
      aria-hidden
    />
  );
}

interface FilterChipProps {
  label: string;
  active: boolean;
  onClick: () => void;
  count?: number;
}

function FilterChip({ label, active, onClick, count }: FilterChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-active={active ? "true" : undefined}
      data-testid={`filter-chip-${label.toLowerCase()}`}
      className={cn(
        "px-3 py-1.5 rounded-full text-[12px] font-medium",
        "border transition-all duration-150",
        active
          ? "bg-[var(--accent)] text-[var(--accent-fg)] border-[var(--accent)]"
          : "bg-[var(--bg-sunken)] text-secondary border-[var(--border-subtle)] hover:border-[var(--border-strong)]",
      )}
    >
      {label}
      {count !== undefined && (
        <span className={cn("ml-1.5", active ? "opacity-90" : "text-tertiary")}>
          {count.toLocaleString()}
        </span>
      )}
    </button>
  );
}

function formatCount(total: number, annotated: number): string {
  return `${total.toLocaleString()} image${total === 1 ? "" : "s"} · ${annotated.toLocaleString()} annotated`;
}

export interface AssetGridProps {
  projectId: string;
  taskId: string;
}

export function AssetGrid({ projectId, taskId }: AssetGridProps) {
  const [searchInput, setSearchInput] = useState("");
  const [status, setStatus] = useState<AssetStatusFilter>("all");
  const debouncedSearch = useDebounced(searchInput, SEARCH_DEBOUNCE_MS);

  const countQ = useQuery({
    queryKey: ["task-assets-count", taskId],
    queryFn: () => assetsApi.count(taskId),
    staleTime: 30_000,
  });

  const pagesQ = useInfiniteQuery({
    queryKey: ["task-assets", taskId, debouncedSearch, status],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      assetsApi.listPage(taskId, {
        limit: PAGE_SIZE,
        offset: pageParam,
        q: debouncedSearch || undefined,
        status,
      }),
    getNextPageParam: (lastPage) => {
      const fetchedSoFar = lastPage.offset + lastPage.items.length;
      return fetchedSoFar < lastPage.total ? fetchedSoFar : undefined;
    },
    placeholderData: keepPreviousData,
  });

  const assets: Asset[] = useMemo(
    () => pagesQ.data?.pages.flatMap((p) => p.items) ?? [],
    [pagesQ.data],
  );
  const total = pagesQ.data?.pages[0]?.total ?? 0;

  // Infinite-scroll trigger: when the user scrolls near the bottom of the
  // scroll container, fetch the next page. We use IntersectionObserver against
  // a sentinel rather than virtualization — for typical 100–500 image tasks a
  // plain CSS grid is fine, and removing the virtualizer eliminates the
  // measure-timing race that produced the 4-vs-6 column regression (v3.1
  // Issue 7).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        if (
          visible &&
          pagesQ.hasNextPage &&
          !pagesQ.isFetchingNextPage
        ) {
          pagesQ.fetchNextPage();
        }
      },
      { root, rootMargin: "200px 0px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [pagesQ, assets.length]);

  const isInitialLoading = pagesQ.isLoading || pagesQ.isPending;
  const isError = pagesQ.isError;

  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div
          className={cn(
            "flex items-center gap-2 flex-1 min-w-[200px] max-w-md",
            "px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--border-subtle)]",
            "bg-[var(--bg-sunken)] focus-within:border-[var(--border-accent)]",
          )}
        >
          <Search className="h-4 w-4 text-tertiary shrink-0" />
          <input
            type="search"
            placeholder="Search by filename…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            data-testid="asset-search-input"
            className={cn(
              "flex-1 bg-transparent outline-none text-[13px] text-primary",
              "placeholder:text-tertiary",
            )}
          />
        </div>
        <div className="flex gap-2" role="tablist" aria-label="Asset status filter">
          <FilterChip
            label="All"
            active={status === "all"}
            onClick={() => setStatus("all")}
            count={countQ.data?.total}
          />
          <FilterChip
            label="Annotated"
            active={status === "annotated"}
            onClick={() => setStatus("annotated")}
            count={countQ.data?.annotated}
          />
          <FilterChip
            label="Unannotated"
            active={status === "unannotated"}
            onClick={() => setStatus("unannotated")}
            count={countQ.data?.unannotated}
          />
        </div>
      </div>

      <p
        className="font-mono-data text-[11px] tracking-[0.12em] uppercase text-tertiary"
        data-testid="asset-count-summary"
      >
        {countQ.data
          ? formatCount(countQ.data.total, countQ.data.annotated)
          : "…"}
        {total !== (countQ.data?.total ?? -1) && total > 0 && (
          <span className="ml-2 text-secondary">
            · showing {Math.min(total, assets.length).toLocaleString()} of{" "}
            {total.toLocaleString()}
          </span>
        )}
      </p>

      {isError && (
        <p className="text-[color:var(--danger)] text-[13px]">
          Failed to load assets.
        </p>
      )}

      {isInitialLoading ? (
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: GRID_TEMPLATE_COLUMNS }}
          data-testid="asset-grid-skeleton"
        >
          {Array.from({ length: 12 }).map((_, i) => (
            <SkeletonTile key={i} />
          ))}
        </div>
      ) : assets.length === 0 ? (
        <p className="text-tertiary text-[13px] italic">
          {debouncedSearch || status !== "all"
            ? "No assets match the current filter."
            : "No assets yet — drop some files above."}
        </p>
      ) : (
        <div
          ref={scrollRef}
          data-testid="asset-grid-virtual-scroll"
          className="overflow-y-auto"
          style={{ height: "70vh", minHeight: 480 }}
        >
          <div
            data-testid="asset-grid"
            className="grid gap-3 px-1"
            style={{ gridTemplateColumns: GRID_TEMPLATE_COLUMNS }}
          >
            {assets.map((a) => (
              <AssetTile
                key={a.id}
                asset={a}
                projectId={projectId}
                taskId={taskId}
              />
            ))}
          </div>
          <div
            ref={sentinelRef}
            data-testid="asset-grid-sentinel"
            aria-hidden
            style={{ height: 1 }}
          />
          {pagesQ.isFetchingNextPage && (
            <p className="text-center text-tertiary text-[12px] py-3">
              Loading more…
            </p>
          )}
        </div>
      )}
    </section>
  );
}
