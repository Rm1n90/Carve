// Armin Mehri — mehri.armin@gmail.com
/**
 * Copy-annotations confirm dialog. Funnel point for both the
 * right-click context-menu flow and the Shift+P prompt flow. Shows the
 * source preview + filename + ordinal + breakdown by kind, plus a
 * "Adds to N existing annotations" hint when the current asset is
 * non-empty. The primary button is disabled when the breakdown is
 * still loading or when there is nothing to copy.
 *
 * Pure presentational — no fetch, no store mutation. The parent owns
 * the wrapper call and the toast.
 */
import { Loader2, ArrowRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import type { Asset } from "@/api/assets";

export interface BreakdownCounts {
  readonly bbox: number;
  readonly polygon: number;
  readonly tag: number;
  readonly mask: number;
  readonly total: number;
}

export interface CopyAnnotationsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceAsset: Asset | null;
  sourceOrdinal: number | null;
  totalAssets: number;
  targetAsset: Asset | null;
  targetExistingCount: number;
  breakdown: BreakdownCounts | "loading" | null;
  onConfirm: () => Promise<void> | void;
}

function pluralize(n: number, singular: string, plural?: string): string {
  return n === 1 ? singular : (plural ?? `${singular}s`);
}

function renderBreakdownLine(b: BreakdownCounts): string {
  if (b.total === 0) return "Nothing to copy";
  const parts: string[] = [];
  if (b.bbox > 0)
    parts.push(`${b.bbox} ${pluralize(b.bbox, "bbox", "bboxes")}`);
  if (b.polygon > 0) parts.push(`${b.polygon} ${pluralize(b.polygon, "polygon")}`);
  if (b.tag > 0) parts.push(`${b.tag} ${pluralize(b.tag, "tag")}`);
  if (b.mask > 0) parts.push(`${b.mask} ${pluralize(b.mask, "mask")}`);
  return parts.join(" · ");
}

export function CopyAnnotationsDialog({
  open,
  onOpenChange,
  sourceAsset,
  sourceOrdinal,
  totalAssets,
  targetAsset,
  targetExistingCount,
  breakdown,
  onConfirm,
}: CopyAnnotationsDialogProps) {
  const loading = breakdown === "loading";
  const counts = breakdown && breakdown !== "loading" ? breakdown : null;
  const total = counts?.total ?? 0;
  const empty = !loading && counts !== null && total === 0;
  const noData = !loading && counts === null;

  const primaryLabel = empty || noData
    ? "Close"
    : `Copy ${total} ${pluralize(total, "annotation")}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[440px]"
        data-testid="copy-annotations-dialog"
        showClose={false}
      >
        <DialogHeader>
          <DialogTitle>Copy annotations</DialogTitle>
          <DialogDescription className="sr-only">
            Confirm copying annotations from{" "}
            {sourceAsset?.original_name ?? "source"} to{" "}
            {targetAsset?.original_name ?? "current asset"}.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-[112px_1fr] gap-3 py-2">
          <div
            className={cn(
              "h-[84px] w-[112px] rounded-[var(--radius-sm)] border",
              "border-[var(--border-subtle)] overflow-hidden bg-[var(--bg-subtle)]",
            )}
            data-testid="copy-dialog-source-thumb"
          >
            {sourceAsset?.thumbnail_url ? (
              <img
                src={sourceAsset.thumbnail_url}
                alt={sourceAsset.original_name}
                className="h-full w-full object-cover"
                decoding="async"
              />
            ) : null}
          </div>
          <div className="flex flex-col justify-center gap-1 min-w-0">
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="text-[13px] font-medium text-[color:var(--text-primary)] truncate">
                {sourceAsset?.original_name ?? "—"}
              </span>
              {sourceOrdinal !== null && totalAssets > 0 && (
                <span className="text-[11px] tabular-nums text-[color:var(--text-tertiary)] shrink-0">
                  {sourceOrdinal} / {totalAssets}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 text-[11.5px] text-[color:var(--text-secondary)]">
              <ArrowRight className="h-3 w-3" aria-hidden />
              <span className="truncate">
                current asset: {targetAsset?.original_name ?? "—"}
              </span>
            </div>
            <div className="text-[12px] text-[color:var(--text-primary)] min-h-[16px]">
              {loading ? (
                <span
                  className="inline-flex items-center gap-1.5 text-[color:var(--text-tertiary)]"
                  data-testid="copy-dialog-breakdown-loading"
                >
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  Counting annotations…
                </span>
              ) : counts ? (
                <span data-testid="copy-dialog-breakdown">
                  {renderBreakdownLine(counts)}
                </span>
              ) : null}
            </div>
            {!empty && !loading && targetExistingCount > 0 && (
              <span className="text-[11px] text-[color:var(--text-tertiary)]">
                Adds to {targetExistingCount} existing{" "}
                {pluralize(targetExistingCount, "annotation")} (Cmd+Z to undo)
              </span>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            data-testid="copy-dialog-cancel"
          >
            Cancel
          </Button>
          <Button
            variant={empty || noData ? "ghost" : "primary"}
            disabled={loading}
            onClick={async () => {
              if (empty || noData) {
                onOpenChange(false);
                return;
              }
              await onConfirm();
            }}
            data-testid="copy-dialog-confirm"
          >
            {primaryLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
