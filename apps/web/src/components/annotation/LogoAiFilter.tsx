// Armin Mehri — mehri.armin@gmail.com
/**
 * Logo AI — score filter.
 *
 * Every box Logo AI writes keeps the model's confidence and its estimate
 * of how much of the logo is in view. So a run can be made once with
 * loose thresholds, and tightened here afterwards without paying for
 * the images again.
 *
 * A popover rather than a dialog on purpose: while it is open the
 * canvas stays visible and hides, live, the boxes the current thresholds
 * would remove. Flip through images, settle on values, then remove for
 * this image or the whole task. Removal is permanent — boxes a person
 * drew, edited or accepted are never touched.
 *
 * The other use of the scores is to review rather than cut. Wrong boxes
 * and real logos overlap in the lower scores, so a threshold strict
 * enough to remove the wrong ones takes real ones with it. "Review"
 * instead shows only the boxes under a score, and the arrow keys then
 * jump between the images that have any: a person looks at a fraction
 * of the boxes and deletes the wrong ones.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, SlidersHorizontal } from "lucide-react";

import { logoAiApi, type LogoAiFilterRequest } from "@/api/logoAi";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover";
import { passesScoreThresholds, type FilterGroup } from "@/lib/annotation-filter";
import { cn } from "@/lib/cn";
import { showToast } from "@/lib/toast";
import { useFilter } from "@/state/annotationFilter";
import { useAnnotations } from "@/state/annotations";
import { useDialogPrefs } from "@/state/dialogPrefs";

interface LogoAiFilterProps {
  taskId?: string;
  /** The asset open in the editor. */
  assetId: string | null;
  /** Called after boxes were removed, so the editor can refetch. */
  onApplied?: () => void;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : word.endsWith("x") ? "es" : "s"}`;
}

/** The annotation filter that "Review" sets: scored boxes under a value. */
export function reviewFilter(under: number): FilterGroup {
  return {
    combinator: "AND",
    rules: [{ not: false, field: "confidence", op: "<", value: under }],
  };
}

/** The score a review filter shows boxes under, or null if the active
 *  filter is not one. */
function reviewingUnder(filter: FilterGroup | null): number | null {
  if (!filter || filter.rules.length !== 1) return null;
  const rule = filter.rules[0];
  if ("combinator" in rule) return null;
  return rule.field === "confidence" && rule.op === "<" && !rule.not
    ? Number(rule.value)
    : null;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

export function LogoAiFilter({ taskId, assetId, onApplied }: LogoAiFilterProps) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [minConfidence, setMinConfidence] = useState(0.7);
  // 60 is what "more than half in view" takes in practice; see the
  // dialog's DEFAULT_MIN_VISIBLE.
  const [minVisible, setMinVisible] = useState(60);
  // Boxes scored 0.90 and up are almost always right; the wrong ones
  // are nearly all under it.
  const [reviewUnder, setReviewUnder] = useState(0.9);
  const activeReview = useFilter((s) => reviewingUnder(s.filter));

  // Start from the thresholds the task's last run used.
  useEffect(() => {
    if (!open) return;
    const stored = useDialogPrefs.getState().getLogoAi(taskId);
    if (!stored) return;
    setMinConfidence(stored.minConfidence);
    if (typeof stored.minVisible === "number") setMinVisible(stored.minVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Live preview on the canvas and in the Objects panel while open.
  useEffect(() => {
    useFilter.getState().setScorePreview(open ? { minConfidence, minVisible } : null);
  }, [open, minConfidence, minVisible]);
  useEffect(() => () => useFilter.getState().setScorePreview(null), []);

  // The open image: counted from what the editor already holds.
  const byId = useAnnotations((s) => s.byId);
  const here = useMemo(() => {
    const scored = Object.values(byId).filter(
      (a) => a.confidence != null && a.status !== "accepted",
    );
    const thresholds = { minConfidence, minVisible };
    const kept = scored.filter((a) => passesScoreThresholds(a, thresholds)).length;
    return { scored: scored.length, below: scored.length - kept };
  }, [byId, minConfidence, minVisible]);

  // The whole task: counted on the server.
  const body: LogoAiFilterRequest = { min_confidence: minConfidence, min_visible: minVisible };
  const debounced = useDebounced(JSON.stringify(body), 350);
  const taskQ = useQuery({
    queryKey: ["logo-ai", "filter-preview", taskId ?? "", debounced],
    queryFn: () =>
      logoAiApi.filterPreview(taskId!, JSON.parse(debounced) as LogoAiFilterRequest),
    enabled: !!taskId && open,
    staleTime: 5_000,
  });
  const task = taskQ.data;

  // How much there is to review: scored boxes under the review value.
  const reviewBody = useDebounced(
    JSON.stringify({ min_confidence: reviewUnder, min_visible: 0 }),
    350,
  );
  const reviewQ = useQuery({
    queryKey: ["logo-ai", "filter-preview", taskId ?? "", reviewBody],
    queryFn: () =>
      logoAiApi.filterPreview(taskId!, JSON.parse(reviewBody) as LogoAiFilterRequest),
    enabled: !!taskId && open,
    staleTime: 5_000,
  });
  const review = reviewQ.data;

  function startReview() {
    useFilter.getState().setFilter(reviewFilter(reviewUnder));
    setOpen(false);
    showToast(
      `Showing only Logo AI boxes scored under ${reviewUnder.toFixed(2)}. ` +
        "← → jump between the images that have any. Stop from the filter button.",
      { variant: "info", duration: 8000 },
    );
  }

  function stopReview() {
    useFilter.getState().clearFilter();
  }

  const apply = useMutation({
    mutationFn: (scope: "image" | "task") =>
      logoAiApi.filterApply(taskId!, {
        ...body,
        ...(scope === "image" && assetId ? { asset_ids: [assetId] } : {}),
      }),
    onSuccess: (res) => {
      showToast(
        res.below > 0
          ? `Removed ${plural(res.below, "box")} from ${plural(res.assets, "image")}.`
          : "Nothing was under those thresholds.",
        { variant: res.below > 0 ? "success" : "info", duration: 5000 },
      );
      qc.invalidateQueries({ queryKey: ["annotations"] });
      qc.invalidateQueries({ queryKey: ["logo-ai", "filter-preview", taskId ?? ""] });
      if (taskId) {
        qc.invalidateQueries({ queryKey: ["task-annotations-raw", taskId] });
        qc.invalidateQueries({ queryKey: ["task-annotations", taskId] });
        qc.invalidateQueries({ queryKey: ["task-assets", taskId] });
      }
      onApplied?.();
    },
    onError: (err) => {
      const e = err as { response?: { data?: { message?: string } }; message?: string };
      showToast(
        `Filter failed: ${e?.response?.data?.message ?? e?.message ?? "request failed"}`,
        { variant: "error", duration: 6000 },
      );
    },
  });

  async function remove(scope: "image" | "task", count: number, images: number) {
    const ok = await confirm({
      title: `Remove ${plural(count, "box")}?`,
      description:
        `This deletes ${plural(count, "Logo AI box")} ` +
        (scope === "image" ? "on this image" : `across ${plural(images, "image")}`) +
        ` scored under ${minConfidence.toFixed(2)} confidence or ${minVisible}% visible. ` +
        "It cannot be undone; getting them back takes a new run. Boxes you drew, " +
        "edited or accepted are not affected.",
      confirmLabel: "Remove",
      variant: "danger",
    });
    if (ok) apply.mutate(scope);
  }

  if (!taskId) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="logo-ai-filter-open"
          aria-label="Filter Logo AI boxes by score"
          title="Filter Logo AI boxes by confidence and visibility"
          className={cn(
            "grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-6)]",
            "transition-colors duration-[180ms] ease-out",
            open
              ? "bg-[var(--bg-hover)] text-[#0d9488]"
              : "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[#0d9488]",
          )}
        >
          <SlidersHorizontal className="h-[16px] w-[16px]" />
        </button>
      </PopoverTrigger>
      {/* Sizes are set on the container: buttons and inputs inherit
          their font (global.css), so a size on the control is ignored. */}
      <PopoverContent className="w-[340px] p-3 grid gap-3 text-[12px]">
        <div data-testid="logo-ai-filter" className="grid gap-1">
          <span className="text-[13px] font-medium">Filter Logo AI boxes</span>
          <span className="text-[11px] text-[color:var(--text-secondary)]">
            Boxes under either value are hidden on the canvas now. Nothing
            is deleted until you remove them below.
          </span>
        </div>

        <label className="grid gap-0.5 text-[11px] text-[color:var(--text-secondary)]">
          <span className="flex items-center justify-between">
            Confidence at least
            <span className="font-mono text-[color:var(--text-primary)]">
              {minConfidence.toFixed(2)}
            </span>
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={minConfidence}
            onChange={(e) => setMinConfidence(Number(e.target.value))}
            data-testid="logo-ai-filter-confidence"
          />
        </label>

        <label className="grid gap-0.5 text-[11px] text-[color:var(--text-secondary)]">
          <span className="flex items-center justify-between">
            Logo visible at least
            <span className="font-mono text-[color:var(--text-primary)]">{minVisible}%</span>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={minVisible}
            onChange={(e) => setMinVisible(Number(e.target.value))}
            data-testid="logo-ai-filter-visible"
          />
        </label>

        <div className="grid gap-1.5 p-2 rounded-[var(--radius-md)] bg-[var(--bg-subtle)]">
          <div className="flex items-center justify-between gap-2">
            <span data-testid="logo-ai-filter-here">
              {here.scored === 0
                ? "This image has no scored boxes"
                : `This image: keeps ${here.scored - here.below} of ${here.scored}`}
            </span>
            <Button
              variant="danger"
              size="sm"
              disabled={here.below === 0 || !assetId || apply.isPending}
              onClick={() => remove("image", here.below, 1)}
              data-testid="logo-ai-filter-apply-image"
            >
              Remove {here.below}
            </Button>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span data-testid="logo-ai-filter-task">
              {task ? (
                task.scored === 0 ? (
                  "No scored boxes in this task"
                ) : (
                  `Whole task: keeps ${task.scored - task.below} of ${task.scored}`
                )
              ) : taskQ.isError ? (
                "Could not count the task"
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  Counting the task…
                </span>
              )}
            </span>
            <Button
              variant="danger"
              size="sm"
              disabled={!task || task.below === 0 || apply.isPending}
              onClick={() => task && remove("task", task.below, task.assets)}
              data-testid="logo-ai-filter-apply-task"
            >
              Remove {task?.below ?? 0}
            </Button>
          </div>
        </div>

        <span className="text-[10.5px] text-[color:var(--text-tertiary)]">
          Only boxes Logo AI made and nobody has changed are counted. Save
          your edits before removing: the image is reloaded afterwards.
        </span>

        <div
          data-testid="logo-ai-review"
          className="grid gap-1.5 pt-3 border-t border-[var(--border-subtle)]"
        >
          <span className="text-[13px] font-medium">Review instead of removing</span>
          <span className="text-[11px] text-[color:var(--text-secondary)]">
            Wrong boxes and real logos share the lower scores, so no threshold
            removes one without the other. Review shows only the boxes under a
            score; you delete the wrong ones and leave the rest.
          </span>
          <label className="grid gap-0.5 text-[11px] text-[color:var(--text-secondary)]">
            <span className="flex items-center justify-between">
              Show only boxes scored under
              <span className="font-mono text-[color:var(--text-primary)]">
                {reviewUnder.toFixed(2)}
              </span>
            </span>
            <input
              type="range"
              min={0.5}
              max={1}
              step={0.05}
              value={reviewUnder}
              onChange={(e) => setReviewUnder(Number(e.target.value))}
              data-testid="logo-ai-review-under"
            />
          </label>
          <div className="flex items-center justify-between gap-2">
            <span data-testid="logo-ai-review-count">
              {review
                ? `${review.below} of ${plural(review.scored, "box")}, on ${plural(review.assets, "image")}`
                : reviewQ.isError
                  ? "Could not count the task"
                  : "Counting…"}
            </span>
            {activeReview != null ? (
              <Button size="sm" onClick={stopReview} data-testid="logo-ai-review-stop">
                Stop reviewing
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={!review || review.below === 0}
                onClick={startReview}
                data-testid="logo-ai-review-start"
              >
                Review
              </Button>
            )}
          </div>
          {activeReview != null && (
            <span className="text-[10.5px] text-[color:var(--accent)]">
              Reviewing boxes scored under {activeReview.toFixed(2)}: only those are
              shown, and ← → skip images without any.
            </span>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
