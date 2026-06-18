// Armin Mehri — mehri.armin@gmail.com
//
// Clear annotations across a user-defined RANGE of assets. Sits next to
// the toolbar's existing "this image" / "all assets" clear options as a
// third, scoped variant. The user types a 1-based asset position range
// (From / To) against the task's canonical asset order — the same order
// the YOLO predict / Auto-Annotate range pickers use — and we delete
// every annotation living on the assets inside that range.
//
// Unlike the YOLO/Auto-Annotate pickers (non-destructive), this is a
// hard delete, so the dialog:
//   - requires BOTH endpoints to be typed (blank fields never default
//     to "everything"),
//   - refuses while there are unsaved local drafts (matching the
//     all-assets clear guard so we never half-delete a session),
//   - the deliberate red "Clear range" button + inline danger warning
//     ARE the confirmation (no nested confirm dialog — the explicit
//     range pick already makes this an intentional action).
import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { Eraser } from "lucide-react";

import { annotationsApi } from "@/api/annotations";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { cn } from "@/lib/cn";
import { bulkClearTaskAnnotationsWithToast } from "@/lib/bulkConvert";
import { showToast } from "@/lib/toast";
import { assetIdsFromRange, clampRange, type RangeInput } from "@/lib/scopeRange";

export interface ClearRangeDialogProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** Open task id. Undefined disables the Clear button. */
  taskId: string | undefined;
  /** Asset ids in canonical task order (Asset.created_at ascending) —
   *  the same order the asset strip and the backend iterate. */
  orderedAssetIds: ReadonlyArray<string>;
  /** Count of unsaved local drafts. >0 blocks the clear so we never
   *  half-delete an in-progress session. */
  dirtyCount: number;
  /** Called after a successful clear so the page can invalidate the
   *  relevant annotation queries. */
  onCleared: () => void;
}

export function ClearRangeDialog({
  open,
  onOpenChange,
  taskId,
  orderedAssetIds,
  dirtyCount,
  onCleared,
}: ClearRangeDialogProps) {
  const [range, setRange] = useState<RangeInput>({ from: "", to: "" });
  const [busy, setBusy] = useState(false);

  const total = orderedAssetIds.length;
  const clamped = clampRange(range, total);
  // Destructive action — both endpoints must be typed. A blank field
  // must NOT silently expand to the full task.
  const bothTyped = range.from !== "" && range.to !== "";
  const canClear =
    !!taskId && total > 0 && bothTyped && clamped.ok && !busy;
  const previewCount =
    bothTyped && clamped.ok ? clamped.to - clamped.from + 1 : 0;

  // Reset the inputs each time the dialog opens so a stale range from a
  // prior session can't be cleared by reflex.
  useEffect(() => {
    if (open) {
      setRange({ from: "", to: "" });
      setBusy(false);
    }
  }, [open]);

  const assetIdSet = useMemo(() => {
    if (!bothTyped || !clamped.ok) return null;
    return new Set(assetIdsFromRange(range, orderedAssetIds).ids);
  }, [bothTyped, clamped.ok, range, orderedAssetIds]);

  function parseField(e: ChangeEvent<HTMLInputElement>): number | "" {
    const raw = e.target.value;
    if (raw === "") return "";
    const n = Number(raw);
    if (!Number.isFinite(n)) return "";
    return Math.trunc(n);
  }

  async function handleClear() {
    if (!taskId || !assetIdSet) return;
    if (dirtyCount > 0) {
      showToast("Save your unsaved changes before clearing a range.", {
        variant: "error",
      });
      return;
    }
    setBusy(true);
    try {
      let raw;
      try {
        raw = await annotationsApi.listForTaskRaw(taskId);
      } catch {
        showToast("Failed to fetch annotations.", { variant: "error" });
        return;
      }
      const inRange = raw.filter(
        (a) => a.asset_id != null && assetIdSet.has(a.asset_id),
      );
      if (inRange.length === 0) {
        showToast("No annotations to clear in the selected range.", {
          variant: "info",
        });
        return;
      }
      await bulkClearTaskAnnotationsWithToast(taskId, inRange, "the selected range");
      onCleared();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  const inputCls = cn(
    "h-7 w-20 px-2 rounded-[var(--radius-sm)] border",
    "border-[var(--border-subtle)] bg-[var(--bg-elev)]",
    "text-[12px] text-[color:var(--text-primary)] outline-none",
    "focus:border-[color:var(--accent)]",
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(92vw,420px)]">
        <div data-testid="clear-range-dialog" className="contents">
        <DialogHeader>
          <DialogTitle>Clear annotations in a range</DialogTitle>
          <DialogDescription>
            Remove every annotation on a span of assets, chosen by their
            1-based position in this task.
          </DialogDescription>
        </DialogHeader>

        {total === 0 ? (
          <div className="text-[12.5px] text-[color:var(--text-tertiary)]">
            This task has no assets.
          </div>
        ) : (
          <div className="grid gap-2" data-testid="clear-range-inputs">
            <div className="flex items-center gap-2 text-[12px] text-[color:var(--text-secondary)]">
              <span>From</span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={total}
                step={1}
                value={range.from}
                onChange={(e) =>
                  setRange((r) => ({ ...r, from: parseField(e) }))
                }
                aria-label="Range from (1-based asset position)"
                data-testid="clear-range-from"
                className={inputCls}
              />
              <span>To</span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={total}
                step={1}
                value={range.to}
                onChange={(e) =>
                  setRange((r) => ({ ...r, to: parseField(e) }))
                }
                aria-label="Range to (1-based asset position)"
                data-testid="clear-range-to"
                className={inputCls}
              />
              <span className="font-mono text-[11px] text-[color:var(--text-tertiary)]">
                / {total}
              </span>
            </div>
            <div
              className="text-[11px] text-[color:var(--text-tertiary)]"
              data-testid="clear-range-preview"
            >
              {previewCount > 0
                ? `Will clear every annotation on ${previewCount} asset${previewCount === 1 ? "" : "s"} (positions ${clamped.from}–${clamped.to}).`
                : "Type a From and To position to enable Clear."}
            </div>
          </div>
        )}

        {previewCount > 0 && (
          <div
            className={cn(
              "mt-3 rounded-[var(--radius-sm)] px-3 py-2 text-[11.5px] leading-relaxed",
              "bg-[var(--danger-bg)] text-[color:var(--danger)]",
            )}
            data-testid="clear-range-warning"
          >
            Every annotation (bbox, polygon, classification tag, mask) on
            assets {clamped.from}–{clamped.to} will be permanently removed.
            Classes are kept. This affects assets that aren't currently open
            and cannot be undone with Cmd+Z.
          </div>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={handleClear}
            disabled={!canClear}
            loading={busy}
            leftIcon={<Eraser className="h-4 w-4" />}
            data-testid="clear-range-confirm"
          >
            Clear range
          </Button>
        </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
