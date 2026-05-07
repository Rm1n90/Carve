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
import {
  VideoExtractPanel,
  DEFAULT_EXTRACT_STRATEGY,
  type ExtractStrategy,
} from "@/components/annotation/VideoExtractPanel";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/cn";

type Strategy = ExtractStrategy["strategy"];

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
 * v3.26 — body delegated to VideoExtractPanel. The dialog only owns
 * the modal chrome, the mutation, and the submit wiring.
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

  const [picker, setPicker] = useState<ExtractStrategy>(
    DEFAULT_EXTRACT_STRATEGY,
  );

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

  const submit = () => {
    const needsN =
      picker.strategy === "every_nth" || picker.strategy === "count";
    const body = {
      strategy: picker.strategy,
      n: needsN ? Math.max(1, picker.n ?? 1) : null,
      quality: picker.quality,
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

        <VideoExtractPanel
          videoCount={1}
          value={picker}
          onChange={setPicker}
        />

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
