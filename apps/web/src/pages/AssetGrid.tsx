import { useEffect, useMemo, useRef, useState } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, Search, Tag, Video, X } from "lucide-react";
import {
  assetsApi,
  type Asset,
  type AssetStatusFilter,
} from "@/api/assets";
import { annotationsApi } from "@/api/annotations";
import { classesApi, type ClassRow } from "@/api/classes";
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
  selected: boolean;
  selectMode: boolean;
  onToggleSelect: (id: string) => void;
}

function AssetTile({
  asset,
  projectId,
  taskId,
  selected,
  selectMode,
  onToggleSelect,
}: AssetTileProps) {
  const interceptNav = (e: React.MouseEvent) => {
    if (!selectMode) return;
    e.preventDefault();
    e.stopPropagation();
    onToggleSelect(asset.id);
  };
  return (
    <div className="group relative">
      <button
        type="button"
        aria-label={selected ? "Deselect asset" : "Select asset"}
        aria-pressed={selected}
        data-testid={`asset-tile-checkbox-${asset.id}`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggleSelect(asset.id);
        }}
        className={cn(
          "absolute top-2 left-2 z-10 grid h-6 w-6 place-items-center",
          "rounded-[var(--radius-xs)] border transition-all duration-150",
          selected
            ? "bg-[var(--accent)] border-[var(--accent)] text-[var(--accent-fg)] opacity-100"
            : "bg-[oklch(0.06_0.012_240_/_0.75)] border-[var(--border-strong)] text-transparent opacity-0 group-hover:opacity-100 hover:text-secondary",
        )}
      >
        <Check className="h-3.5 w-3.5" strokeWidth={3} />
      </button>
      <Link
      to="/projects/$projectId/tasks/$taskId/assets/$assetId"
      params={{ projectId, taskId, assetId: asset.id }}
      onClick={interceptNav}
      className={cn(
        "group block",
        selected && "outline outline-2 outline-[var(--accent)] rounded-[var(--radius-md)]",
      )}
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
    </div>
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
  // Plan-18 — multi-select & bulk classify. Selection lives only in
  // memory; navigation, filter changes, and tab switches reset it.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkResult, setBulkResult] = useState<
    { tagged: number; skipped: number; failed: number; className: string } | null
  >(null);
  const queryClient = useQueryClient();
  const toggleSelect = (id: string) => {
    // Starting a new selection wave clears any lingering result toast so
    // the new floating bar doesn't stack on top of the old toast at the
    // same screen position.
    setBulkResult(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectMode = selected.size > 0;

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

  // Reset selection when the visible set changes meaningfully (status
  // filter or search). Avoids leaving stale ids selected while the user
  // is looking at a different slice of the task.
  useEffect(() => {
    setSelected(new Set());
  }, [status, debouncedSearch, taskId]);

  const classesQ = useQuery({
    queryKey: ["project-classes", projectId],
    queryFn: () => classesApi.listForProject(projectId),
    enabled: bulkOpen,
    staleTime: 60_000,
  });

  const bulkTagMut = useMutation({
    mutationFn: (input: { class_id: string; className: string }) =>
      annotationsApi
        .bulkTagAssets(taskId, {
          asset_ids: Array.from(selected),
          class_id: input.class_id,
        })
        .then((r) => ({ ...r, className: input.className })),
    onSuccess: (res) => {
      setBulkResult(res);
      setBulkOpen(false);
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ["task-assets-count", taskId] });
      queryClient.invalidateQueries({ queryKey: ["task-assets", taskId] });
    },
  });

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
                selected={selected.has(a.id)}
                selectMode={selectMode}
                onToggleSelect={toggleSelect}
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

      {selectMode && (
        <div
          data-testid="asset-bulk-action-bar"
          className={cn(
            "fixed bottom-6 left-1/2 z-30 -translate-x-1/2",
            "flex items-center gap-3 px-4 py-2.5",
            "rounded-full border border-[var(--border-strong)] bg-[var(--bg-elev)]",
            "shadow-[0_8px_32px_oklch(0_0_0_/_0.32)]",
          )}
        >
          <span className="font-mono-data text-[12px] tracking-tight text-secondary">
            <span className="text-primary font-semibold">{selected.size}</span> selected
          </span>
          <button
            type="button"
            data-testid="asset-bulk-tag-trigger"
            onClick={() => setBulkOpen(true)}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium",
              "bg-[var(--accent)] text-[var(--accent-fg)] hover:opacity-90",
            )}
          >
            <Tag className="h-3.5 w-3.5" />
            Tag with class…
          </button>
          <button
            type="button"
            aria-label="Clear selection"
            data-testid="asset-bulk-clear"
            onClick={() => setSelected(new Set())}
            className="grid h-7 w-7 place-items-center rounded-full text-tertiary hover:text-primary hover:bg-[var(--bg-hover)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {bulkOpen && (
        <BulkClassifyDialog
          count={selected.size}
          classes={classesQ.data ?? []}
          isLoading={classesQ.isLoading}
          isPending={bulkTagMut.isPending}
          onCancel={() => setBulkOpen(false)}
          onPick={(cls) =>
            bulkTagMut.mutate({ class_id: cls.id, className: cls.name })
          }
        />
      )}

      {bulkResult && (
        <BulkResultToast
          result={bulkResult}
          onDismiss={() => setBulkResult(null)}
        />
      )}
    </section>
  );
}

interface BulkClassifyDialogProps {
  count: number;
  classes: ClassRow[];
  isLoading: boolean;
  isPending: boolean;
  onCancel: () => void;
  onPick: (cls: ClassRow) => void;
}

function BulkClassifyDialog({
  count,
  classes,
  isLoading,
  isPending,
  onCancel,
  onPick,
}: BulkClassifyDialogProps) {
  const sorted = useMemo(
    () => [...classes].sort((a, b) => a.idx - b.idx),
    [classes],
  );
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Bulk classify"
      data-testid="bulk-classify-dialog"
      className={cn(
        "fixed inset-0 z-50 grid place-items-center",
        "bg-[oklch(0.04_0.008_240_/_0.78)] backdrop-blur-sm",
      )}
      onClick={onCancel}
    >
      <div
        className={cn(
          "w-[min(520px,calc(100vw-32px))] max-h-[70vh] grid gap-3 p-5",
          "rounded-[var(--radius-lg)] border border-[var(--border-strong)] bg-[var(--bg-elev)]",
          "shadow-[0_24px_64px_oklch(0_0_0_/_0.55)]",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-baseline justify-between gap-3">
          <h2 className="font-editorial text-[18px] leading-none text-primary">
            Tag {count} asset{count === 1 ? "" : "s"}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onCancel}
            disabled={isPending}
            className="grid h-7 w-7 place-items-center rounded-full text-tertiary hover:text-primary hover:bg-[var(--bg-hover)] disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <p className="text-[12.5px] text-secondary">
          Pick a class to apply as a frame-level tag on every selected
          asset. Already-tagged assets are skipped.
        </p>
        <div className="overflow-y-auto -mx-1 px-1">
          {isLoading ? (
            <p className="text-tertiary text-[12.5px] italic py-6 text-center">
              Loading classes…
            </p>
          ) : sorted.length === 0 ? (
            <p className="text-tertiary text-[12.5px] italic py-6 text-center">
              No classes defined for this project yet.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {sorted.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  data-testid={`bulk-classify-pick-${c.id}`}
                  onClick={() => onPick(c)}
                  disabled={isPending}
                  className={cn(
                    "inline-flex items-center gap-2 h-8 px-3 rounded-full text-[12.5px]",
                    "border border-[var(--border-strong)] bg-transparent text-secondary",
                    "hover:text-primary hover:border-[var(--accent)]",
                    "disabled:opacity-50 disabled:cursor-wait",
                  )}
                >
                  <span
                    aria-hidden
                    className="h-2.5 w-2.5 rounded-full shrink-0"
                    style={{ background: c.color }}
                  />
                  <span className="truncate max-w-[160px]">{c.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="px-3 py-1.5 rounded-full text-[12px] text-secondary hover:text-primary hover:bg-[var(--bg-hover)] disabled:opacity-50"
          >
            Cancel
          </button>
        </footer>
      </div>
    </div>
  );
}

interface BulkResultToastProps {
  result: { tagged: number; skipped: number; failed: number; className: string };
  onDismiss: () => void;
}

function BulkResultToast({ result, onDismiss }: BulkResultToastProps) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 6000);
    return () => clearTimeout(t);
  }, [onDismiss]);
  return (
    <div
      role="status"
      data-testid="bulk-classify-result"
      className={cn(
        "fixed bottom-6 left-1/2 z-30 -translate-x-1/2",
        "flex items-center gap-3 px-4 py-2.5",
        "rounded-full border border-[var(--border-accent)] bg-[var(--bg-elev)]",
        "shadow-[0_8px_32px_oklch(0_0_0_/_0.32)]",
      )}
    >
      <Check className="h-4 w-4 text-[color:var(--accent)]" />
      <span className="text-[12.5px] text-primary">
        Tagged <span className="font-semibold">{result.tagged}</span> as{" "}
        <span className="font-semibold">{result.className}</span>
        {result.skipped > 0 && (
          <span className="text-tertiary">
            {" "}· {result.skipped} already tagged
          </span>
        )}
        {result.failed > 0 && (
          <span className="text-[color:var(--danger)]">
            {" "}· {result.failed} failed
          </span>
        )}
      </span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="grid h-6 w-6 place-items-center rounded-full text-tertiary hover:text-primary hover:bg-[var(--bg-hover)]"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
