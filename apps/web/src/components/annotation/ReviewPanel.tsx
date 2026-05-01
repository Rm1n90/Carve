/**
 * Plan-09 Phase 5 Task 3 — annotation review panel.
 *
 * Lists annotations grouped by review status with per-row Accept /
 * Reject affordances, a "Review all proposed" bulk CTA, status filter
 * pills, and keyboard shortcuts (A / R) when a single annotation is
 * selected.
 *
 * Optimistic update pattern:
 *   - Click Accept → flip the local draft's status to ``accepted``.
 *   - Fire ``annotationsApi.review(id, "accept")`` in the background.
 *   - On success, apply the server-authoritative ``reviewedById`` /
 *     ``reviewedAt`` / ``prevGeometry`` from the response.
 *   - On failure, revert the local flip and toast the error.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Eye, EyeOff, Loader2, X } from "lucide-react";

import {
  annotationsApi,
  type ReviewDecision,
} from "@/api/annotations";
import { cn } from "@/lib/cn";
import { showToast } from "@/lib/toast";
import { formatRelative } from "@/lib/relativeTime";
import {
  useAnnotations,
  type AnnotationDraft,
  type ReviewStatePatch,
  type ReviewStatus,
} from "@/state/annotations";
import { useReviewCompare } from "@/state/reviewCompare";
import { useOptionalConfirm } from "@/components/ui/ConfirmDialog";
import type { ClassRow } from "@/api/classes";

export type ReviewFilter = "all" | ReviewStatus;

interface ReviewPanelProps {
  classes?: ClassRow[];
  /**
   * Optional reviewer-name resolver (e.g. backed by a members cache).
   * When omitted (or it returns null), the row renders without a
   * reviewer name — the row itself still renders.
   */
  resolveReviewerName?: (id: string) => string | null;
}

const FILTERS: { value: ReviewFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "proposed", label: "Proposed" },
  { value: "accepted", label: "Accepted" },
  { value: "rejected", label: "Rejected" },
];

function describeApiError(err: unknown): string {
  const e = err as
    | { response?: { data?: { detail?: string; error?: string } }; message?: string }
    | undefined;
  return (
    e?.response?.data?.detail ??
    e?.response?.data?.error ??
    e?.message ??
    "Request failed"
  );
}

function statusBadgeClass(status: ReviewStatus): string {
  switch (status) {
    case "accepted":
      return "bg-[oklch(0.85_0.12_145_/0.25)] text-[oklch(0.45_0.16_145)]";
    case "rejected":
      return "bg-[oklch(0.85_0.16_25_/0.25)] text-[oklch(0.5_0.2_25)]";
    default:
      return "bg-[var(--bg-subtle)] text-[color:var(--text-secondary)]";
  }
}

function snapshotReview(d: AnnotationDraft): ReviewStatePatch {
  return {
    status: d.status ?? "proposed",
    reviewedById: d.reviewedById ?? null,
    reviewedAt: d.reviewedAt ?? null,
    prevGeometry: d.prevGeometry ?? null,
  };
}

export function ReviewPanel({
  classes,
  resolveReviewerName,
}: ReviewPanelProps) {
  const byId = useAnnotations((s) => s.byId);
  const selectedId = useAnnotations((s) => s.selectedId);
  const selectedIds = useAnnotations((s) => s.selectedIds);
  const setReviewState = useAnnotations((s) => s.setReviewState);
  const revertReviewState = useAnnotations((s) => s.revertReviewState);
  // Plan-09 Phase 5 Task 4 — prev-revision compare bridge.
  const pinnedCompare = useReviewCompare((s) => s.pinned);
  const setHoverCompare = useReviewCompare((s) => s.setHover);
  const togglePinCompare = useReviewCompare((s) => s.togglePin);
  const unpinCompare = useReviewCompare((s) => s.unpin);
  const confirm = useOptionalConfirm();

  const [filter, setFilter] = useState<ReviewFilter>("proposed");
  const [bulkBusy, setBulkBusy] = useState(false);
  // In-flight per-row review calls, keyed by draft.tempId. Tracked in
  // state so per-row buttons rerender disabled, AND in a ref so the
  // keyboard handler can read the current set without re-binding.
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const busyRef = useRef<Set<string>>(busy);
  busyRef.current = busy;

  const drafts = useMemo(() => Object.values(byId), [byId]);
  const visibleDrafts = useMemo(() => {
    if (filter === "all") return drafts;
    return drafts.filter((d) => (d.status ?? "proposed") === filter);
  }, [drafts, filter]);

  const proposedDrafts = useMemo(
    () => drafts.filter((d) => (d.status ?? "proposed") === "proposed"),
    [drafts],
  );

  const classMap = useMemo(() => {
    const map: Record<string, ClassRow> = {};
    for (const c of classes ?? []) map[c.id] = c;
    return map;
  }, [classes]);

  const applyReview = useCallback(
    async (
      draft: AnnotationDraft,
      decision: ReviewDecision,
    ): Promise<void> => {
      const id = draft.tempId;
      // Race guard: if a review call is already in flight for this id,
      // no-op. Whichever optimistic flip is mid-flight wins.
      if (busyRef.current.has(id)) return;
      const before = snapshotReview(draft);
      // Mark in-flight (new Set for immutability + rerender).
      setBusy((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      // Optimistic flip.
      setReviewState(id, {
        status: decision === "accept" ? "accepted" : "rejected",
      });
      const target = draft.serverId ?? id;
      try {
        const updated = await annotationsApi.review(target, decision);
        // Server is the source of truth for reviewer + timestamp +
        // prev_geometry. Apply on top of the optimistic flip.
        setReviewState(id, {
          status:
            updated.status ?? (decision === "accept" ? "accepted" : "rejected"),
          reviewedById: updated.reviewedById ?? null,
          reviewedAt: updated.reviewedAt ?? null,
          prevGeometry: updated.prevGeometry ?? null,
        });
      } catch (err) {
        revertReviewState(id, before);
        showToast(describeApiError(err), { variant: "error", duration: 6000 });
      } finally {
        setBusy((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [setReviewState, revertReviewState],
  );

  async function handleBulkAccept(): Promise<void> {
    if (proposedDrafts.length === 0) return;
    const ok = await confirm({
      title: `Accept ${proposedDrafts.length} proposed annotation${
        proposedDrafts.length === 1 ? "" : "s"
      }?`,
      description:
        "All currently proposed annotations will be marked accepted.",
      confirmLabel: "Accept all",
    });
    if (!ok) return;
    // Filter out local-only drafts (no serverId): the server can't
    // review what it doesn't know about. Surface a soft warning so the
    // user knows some rows were skipped.
    const persisted = proposedDrafts.filter((d) => Boolean(d.serverId));
    const skippedUnsaved = proposedDrafts.length - persisted.length;
    if (skippedUnsaved > 0) {
      showToast(
        `Skipped ${skippedUnsaved} unsaved annotation${
          skippedUnsaved === 1 ? "" : "s"
        } — save first.`,
        { variant: "warning" },
      );
    }
    if (persisted.length === 0) return;
    setBulkBusy(true);
    const targets = persisted.map((d) => ({
      draft: d,
      before: snapshotReview(d),
      serverId: d.serverId as string,
    }));
    // Optimistic flip for every target.
    for (const t of targets) {
      setReviewState(t.draft.tempId, { status: "accepted" });
    }
    try {
      const result = await annotationsApi.batchReview(
        targets.map((t) => t.serverId),
        "accept",
      );
      // Anything the server reports as ``skipped`` should NOT remain
      // optimistically accepted — revert those.
      const skipped = new Set(result.skipped);
      for (const t of targets) {
        if (skipped.has(t.serverId)) {
          revertReviewState(t.draft.tempId, t.before);
        }
      }
      showToast(
        `Accepted ${result.reviewed.length} annotation${
          result.reviewed.length === 1 ? "" : "s"
        }${result.skipped.length > 0 ? `, skipped ${result.skipped.length}` : ""}.`,
        { variant: "success" },
      );
    } catch (err) {
      // Revert all optimistic flips on bulk failure.
      for (const t of targets) {
        revertReviewState(t.draft.tempId, t.before);
      }
      showToast(describeApiError(err), { variant: "error", duration: 6000 });
    } finally {
      setBulkBusy(false);
    }
  }

  // Plan-09 Phase 5 Task 4 — drop pinned compare entries whose row is
  // no longer in the store (annotation deleted). Hovered entries are
  // always cleared by the row's mouse-leave; pinned entries persist
  // across selection changes so we have to GC them here.
  useEffect(() => {
    for (const id of pinnedCompare) {
      if (!byId[id]) unpinCompare(id);
    }
  }, [byId, pinnedCompare, unpinCompare]);

  // Keyboard: A/R when a SINGLE annotation is selected and the user
  // isn't typing into a text input.
  useEffect(() => {
    function isEditableTarget(t: EventTarget | null): boolean {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (t.isContentEditable) return true;
      return false;
    }
    function handler(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      if (selectedIds.length !== 1 || !selectedId) return;
      const draft = useAnnotations.getState().byId[selectedId];
      if (!draft) return;
      const key = e.key.toLowerCase();
      if (key === "a") {
        e.preventDefault();
        void applyReview(draft, "accept");
      } else if (key === "r") {
        e.preventDefault();
        void applyReview(draft, "reject");
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // deps intentional: handler reads live state via useAnnotations.getState()
    // and busyRef.current, so a stale closure on selectedId/applyReview is fine.
  }, [selectedId, selectedIds.length]);

  return (
    <aside
      role="complementary"
      aria-label="Annotation review"
      data-testid="review-panel"
      className={cn(
        "flex flex-col gap-3 p-3 text-[12.5px]",
        "glass-surface",
      )}
    >
      <header className="flex items-center justify-between">
        <span className="font-medium tracking-tight text-[color:var(--text-primary)]">
          Review
        </span>
        <span
          data-testid="review-panel-count"
          className="font-mono tabular-nums text-[10.5px] text-[color:var(--text-tertiary)]"
        >
          {visibleDrafts.length} / {drafts.length}
        </span>
      </header>

      <nav
        aria-label="Filter by review status"
        data-testid="review-panel-filters"
        className="flex flex-wrap gap-1"
      >
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            data-testid={`review-filter-${f.value}`}
            aria-pressed={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={cn(
              "px-2.5 py-1 rounded-full text-[11.5px] tracking-tight transition-colors",
              filter === f.value
                ? "bg-[var(--accent)] text-[color:var(--accent-fg)]"
                : "bg-[var(--bg-subtle)] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)]",
            )}
          >
            {f.label}
          </button>
        ))}
      </nav>

      <button
        type="button"
        data-testid="review-bulk-accept"
        onClick={() => void handleBulkAccept()}
        disabled={bulkBusy || proposedDrafts.length === 0}
        className={cn(
          "inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-full",
          "bg-[var(--accent)] text-[color:var(--accent-fg)] text-[12px] font-medium",
          "hover:bg-[var(--accent-hover)] transition-colors",
          "disabled:bg-[var(--bg-subtle)] disabled:text-[color:var(--text-tertiary)] disabled:cursor-not-allowed",
        )}
      >
        {bulkBusy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Check className="h-3.5 w-3.5" />
        )}
        Review all proposed
        {proposedDrafts.length > 0 && (
          <span className="font-mono tabular-nums text-[10.5px] opacity-80">
            ({proposedDrafts.length})
          </span>
        )}
      </button>

      {visibleDrafts.length === 0 ? (
        <p
          data-testid="review-panel-empty"
          className="text-[11.5px] text-[color:var(--text-tertiary)]"
        >
          No annotations match this filter.
        </p>
      ) : (
        <ul
          data-testid="review-panel-list"
          className="grid gap-1.5"
        >
          {visibleDrafts.map((d) => {
            const status: ReviewStatus = d.status ?? "proposed";
            const cls = classMap[d.classId];
            const reviewerName =
              d.reviewedById && resolveReviewerName
                ? resolveReviewerName(d.reviewedById)
                : null;
            const hasPrev = Boolean(d.prevGeometry);
            const isPinned = pinnedCompare.has(d.tempId);
            return (
              <li
                key={d.tempId}
                data-testid={`review-row-${d.tempId}`}
                data-status={status}
                onMouseEnter={
                  hasPrev ? () => setHoverCompare(d.tempId, true) : undefined
                }
                onMouseLeave={
                  hasPrev ? () => setHoverCompare(d.tempId, false) : undefined
                }
                className={cn(
                  "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-sm)]",
                  "border border-[var(--glass-border)] bg-[var(--bg-subtle)]/50",
                )}
              >
                <span
                  data-testid={`review-row-status-${d.tempId}`}
                  className={cn(
                    "px-1.5 py-0.5 rounded-full text-[10px] uppercase tracking-[0.06em] font-medium",
                    statusBadgeClass(status),
                  )}
                >
                  {status}
                </span>
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-full border border-[var(--border-strong)]"
                  style={{ background: cls?.color ?? "var(--bg-hover)" }}
                />
                <span className="flex-1 min-w-0 truncate text-[12px] text-[color:var(--text-primary)]">
                  {cls?.name ?? d.classId}
                </span>
                {d.reviewedAt && (
                  <span
                    data-testid={`review-row-meta-${d.tempId}`}
                    className="text-[10.5px] text-[color:var(--text-tertiary)] shrink-0"
                  >
                    {reviewerName ? `${reviewerName} · ` : ""}
                    {formatRelative(d.reviewedAt)}
                  </span>
                )}
                <div className="flex items-center gap-0.5 shrink-0">
                  {hasPrev && (
                    <button
                      type="button"
                      title={isPinned ? "Hide prev" : "Show prev"}
                      aria-label={
                        isPinned
                          ? `Hide previous geometry of ${cls?.name ?? d.classId}`
                          : `Show previous geometry of ${cls?.name ?? d.classId}`
                      }
                      aria-pressed={isPinned}
                      data-testid={`review-row-compare-${d.tempId}`}
                      onClick={() => togglePinCompare(d.tempId)}
                      className={cn(
                        "inline-flex items-center justify-center h-6 w-6 rounded-full",
                        "transition-colors",
                        isPinned
                          ? "bg-[var(--accent)] text-[color:var(--accent-fg)]"
                          : "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)]",
                      )}
                    >
                      {isPinned ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    title="Accept"
                    aria-label={`Accept annotation ${cls?.name ?? d.classId}`}
                    data-testid={`review-row-accept-${d.tempId}`}
                    onClick={() => void applyReview(d, "accept")}
                    disabled={busy.has(d.tempId)}
                    className={cn(
                      "inline-flex items-center justify-center h-6 w-6 rounded-full",
                      "text-[oklch(0.5_0.18_145)] hover:bg-[oklch(0.85_0.12_145_/0.25)]",
                      "transition-colors",
                      "disabled:opacity-50 disabled:cursor-not-allowed",
                    )}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Reject"
                    aria-label={`Reject annotation ${cls?.name ?? d.classId}`}
                    data-testid={`review-row-reject-${d.tempId}`}
                    onClick={() => void applyReview(d, "reject")}
                    disabled={busy.has(d.tempId)}
                    className={cn(
                      "inline-flex items-center justify-center h-6 w-6 rounded-full",
                      "text-[oklch(0.5_0.2_25)] hover:bg-[oklch(0.85_0.16_25_/0.25)]",
                      "transition-colors",
                      "disabled:opacity-50 disabled:cursor-not-allowed",
                    )}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
