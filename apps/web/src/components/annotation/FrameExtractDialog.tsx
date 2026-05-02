// Armin Mehri — mehri.armin@gmail.com
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Film, Loader2 } from "lucide-react";

import { assetsApi } from "@/api/assets";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/cn";

type Strategy = "auto" | "all" | "every_nth" | "count";

interface FrameExtractDialogProps {
  /** v3.8 Phase 4-video step E -- when set, the dialog re-extracts the
   *  given asset's frames via assetsApi.reextractFrames. When omitted,
   *  the dialog only fires its onSubmit callback (used by upload). */
  assetId?: string;
  /** Optional render override for the trigger. Default = a small toolbar
   *  button labelled "Re-extract frames". When ``open`` is provided
   *  externally the trigger is suppressed (controlled mode for upload). */
  trigger?: React.ReactNode;
  /** Controlled-open mode (for upload-time use). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Fired with the chosen strategy when the user confirms. The upload
   *  flow uses this to remember the choice and trigger extraction
   *  itself after the upload finishes; re-extract mode submits inline
   *  via assetsApi.reextractFrames and ignores this. */
  onSubmit?: (body: {
    strategy: Strategy;
    n: number | null;
    quality: number;
  }) => void;
}

/**
 * v3.8 Phase 4-video step E -- frame extraction strategy picker.
 *
 * Used in two places:
 *  1. Editor toolbar "Re-extract frames" button (assetId set)
 *  2. AssetUploadDialog after a video file is selected (controlled
 *     open + onSubmit callback; assetId omitted)
 *
 * Strategies (mirror the worker):
 *  - auto       -- worker decides; cap ~500 frames
 *  - all        -- every frame
 *  - every_nth  -- every Nth (user picks N)
 *  - count      -- exactly K frames evenly spaced (user picks K)
 */
export function FrameExtractDialog({
  assetId,
  trigger,
  open: openProp,
  onOpenChange,
  onSubmit,
}: FrameExtractDialogProps) {
  const qc = useQueryClient();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;

  const [strategy, setStrategy] = useState<Strategy>("count");
  const [nValue, setNValue] = useState<number>(500);
  const [quality, setQuality] = useState<number>(75);

  const reextract = useMutation({
    mutationFn: (body: {
      strategy: Strategy;
      n: number | null;
      quality: number;
    }) => {
      if (!assetId) throw new Error("no_asset");
      return assetsApi.reextractFrames(assetId, body);
    },
    onSuccess: () => {
      showToast("Frame extraction started.", { variant: "success" });
      qc.invalidateQueries({ queryKey: ["frames", assetId] });
      setOpen(false);
    },
    onError: () => {
      showToast("Failed to start extraction.", { variant: "error" });
    },
  });

  const needsN = strategy === "every_nth" || strategy === "count";
  const submit = () => {
    const body = {
      strategy,
      n: needsN ? Math.max(1, nValue) : null,
      quality,
    };
    if (assetId) {
      reextract.mutate(body);
    } else {
      onSubmit?.(body);
      setOpen(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger !== undefined ? (
        <DialogTrigger asChild>{trigger}</DialogTrigger>
      ) : openProp === undefined ? (
        <DialogTrigger asChild>
          <button
            type="button"
            data-testid="frame-extract-trigger"
            className={cn(
              "inline-flex items-center gap-1.5 h-8 px-3",
              "rounded-[var(--radius-sm)] border border-[var(--border-subtle)]",
              "text-[12.5px] tracking-tight text-[color:var(--text-secondary)]",
              "hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
              "transition-colors",
            )}
            title="Re-extract video frames with a different strategy"
          >
            <Film className="h-3.5 w-3.5" />
            Re-extract frames
          </button>
        </DialogTrigger>
      ) : null}
      <DialogContent className="w-[min(92vw,520px)]">
        <DialogHeader>
          <DialogTitle>Frame extraction</DialogTitle>
          <DialogDescription>
            Pick how many frames to extract from this video. Annotations
            attached to old frame_ids stay in the database; switch to a
            previously-used strategy to see them again.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 mt-1">
          {(
            [
              {
                key: "auto" as const,
                title: "Auto",
                desc: "Caps at ~500 frames; downsamples long videos.",
              },
              {
                key: "all" as const,
                title: "All frames",
                desc: "Every frame. Most accurate; biggest storage.",
              },
              {
                key: "every_nth" as const,
                title: "Every N-th frame",
                desc: "Skip in steps. Good for high-fps videos.",
              },
              {
                key: "count" as const,
                title: "Total of K frames (smart)",
                desc: "Evenly spaced K frames across the video. If the video has fewer than K, all are kept.",
              },
            ] as const
          ).map((opt) => {
            const active = strategy === opt.key;
            return (
              <label
                key={opt.key}
                data-testid={`frame-extract-strategy-${opt.key}`}
                className={cn(
                  "flex items-start gap-2.5 px-3 py-2 cursor-pointer",
                  "rounded-[var(--radius-sm)] border transition-colors",
                  active
                    ? "border-[var(--accent)] bg-[var(--accent-bg)]"
                    : "border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]",
                )}
              >
                <input
                  type="radio"
                  name="frame-extract-strategy"
                  checked={active}
                  onChange={() => setStrategy(opt.key)}
                  className="mt-0.5"
                />
                <div className="grid gap-0.5">
                  <div className="text-[13px] text-[color:var(--text-primary)]">
                    {opt.title}
                  </div>
                  <div className="text-[11.5px] text-[color:var(--text-tertiary)]">
                    {opt.desc}
                  </div>
                </div>
              </label>
            );
          })}
        </div>

        {needsN && (
          <div className="flex items-center gap-2 mt-3">
            <label
              htmlFor="frame-extract-n"
              className="text-[12px] text-[color:var(--text-secondary)]"
            >
              {strategy === "every_nth" ? "N (step):" : "K (total frames):"}
            </label>
            <input
              id="frame-extract-n"
              type="number"
              min={1}
              max={100000}
              value={nValue}
              onChange={(e) =>
                setNValue(Math.max(1, parseInt(e.target.value, 10) || 1))
              }
              data-testid="frame-extract-n"
              className={cn(
                "h-8 w-24 px-2 rounded-[var(--radius-xs)]",
                "bg-[var(--bg-sunken)] text-[13px] text-[color:var(--text-primary)]",
                "border border-[var(--border-subtle)]",
                "focus:outline-none focus:border-[var(--accent)]",
              )}
            />
          </div>
        )}

        {/* v3.8 Phase 4-video step F2 — JPEG quality 0..100. */}
        <div className="grid gap-1.5 mt-3">
          <div className="flex items-center justify-between">
            <label
              htmlFor="frame-extract-quality"
              className="text-[12px] text-[color:var(--text-secondary)]"
            >
              Quality
            </label>
            <span className="font-mono text-[11.5px] text-[color:var(--text-tertiary)] tabular-nums">
              {quality} / 100
            </span>
          </div>
          <input
            id="frame-extract-quality"
            type="range"
            min={0}
            max={100}
            step={5}
            value={quality}
            onChange={(e) => setQuality(parseInt(e.target.value, 10) || 0)}
            data-testid="frame-extract-quality"
          />
          <p className="text-[11px] italic text-[color:var(--text-tertiary)]">
            Higher = sharper frames + more storage. 75 is balanced; 90+
            for downstream model accuracy on small objects.
          </p>
        </div>

        <p className="text-[11px] italic text-[color:var(--text-tertiary)] mt-3">
          The original video file is kept after extraction so SAM video
          tracking and Re-extract still work. Delete the asset to remove
          everything.
        </p>

        <DialogFooter>
          <Button variant="ghost" size="md" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            disabled={reextract.isPending}
            loading={reextract.isPending}
            onClick={submit}
            data-testid="frame-extract-submit"
            leftIcon={
              reextract.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : undefined
            }
          >
            {assetId ? "Re-extract" : "Continue upload"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
