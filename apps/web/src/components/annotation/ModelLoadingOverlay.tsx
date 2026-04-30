/**
 * v3.5 Phase C — SAM model load progress overlay.
 *
 * Polls ``GET /models/sam-status`` every 1500ms while ``open`` is true
 * and dismisses when the state machine transitions to ``ready`` or
 * ``error``. The frontend uses this for two flows:
 *
 *   1. Variant switch (SamVariantSwitcher fires the mutation, then opens
 *      this overlay so the user sees a "Loading sam2.1-large…" panel
 *      while HF downloads ~2.4 GB of weights).
 *   2. Editor first-encode (AnnotationCanvas opens the overlay before
 *      calling samTool.activate() so the long initial encode shows
 *      progress instead of looking frozen).
 *
 * The Cancel button only dismisses the modal client-side. Server-side
 * the load continues to completion — there's no good way to abort an
 * HF download mid-flight without leaving the predictor in a half-built
 * state. The user can switch variants after the load finishes.
 */

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { modelsApi, type SamLoadStatus } from "@/api/phase2";
import { cn } from "@/lib/cn";

export interface ModelLoadingOverlayProps {
  /** Render the overlay only while ``true``. Polling auto-stops when closed. */
  open: boolean;
  /** Fired when the user cancels OR the state transitions to ready/error. */
  onClose: () => void;
  /** Fired when state transitions to ``error``; receives the error detail. */
  onError?: (error: string) => void;
  /** Optional override variant label. Used while the switch mutation is
   *  in flight before the status endpoint reflects the new variant. */
  variantHint?: string;
}

const POLL_INTERVAL_MS = 1500;

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return "";
  const gb = bytes / 1_000_000_000;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1_000_000;
  return `${mb.toFixed(0)} MB`;
}

export function ModelLoadingOverlay(props: ModelLoadingOverlayProps) {
  // Cheap guard: when the overlay is closed we render nothing AND skip
  // ``useQuery`` entirely. Keeping useQuery hidden behind the guard
  // means consumer trees that don't host a QueryClientProvider (e.g.
  // canvas tests that mount AnnotationCanvas in isolation) keep
  // working — the overlay only needs the provider when it's actually
  // visible, which is the production path. v3.5 Phase C.
  if (!props.open) return null;
  return <ModelLoadingOverlayInner {...props} />;
}

function ModelLoadingOverlayInner({
  open,
  onClose,
  onError,
  variantHint,
}: ModelLoadingOverlayProps) {
  const statusQ = useQuery<SamLoadStatus>({
    queryKey: ["sam-load-status"],
    queryFn: () => modelsApi.samStatus(),
    enabled: open,
    refetchInterval: open ? POLL_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    // Stale immediately so each poll actually hits the network.
    staleTime: 0,
  });

  const status = statusQ.data;
  const state = status?.state;
  const variant = variantHint || status?.variant || "SAM";
  const progressBytes = status?.progress_bytes ?? null;
  const progressTotal = status?.progress_total ?? null;
  const hasRealProgress =
    progressBytes != null && progressTotal != null && progressTotal > 0;
  const pct = hasRealProgress
    ? Math.min(100, Math.round((progressBytes! / progressTotal!) * 100))
    : null;

  // Auto-dismiss on terminal states. Fire onError BEFORE onClose so
  // callers can latch the error message before the modal unmounts.
  useEffect(() => {
    if (!open) return;
    if (state === "ready") {
      onClose();
    } else if (state === "error") {
      const detail = status?.error || "model_load_failed";
      onError?.(detail);
      onClose();
    }
  }, [open, state, status?.error, onClose, onError]);

  if (!open) return null;

  // Title copy depends on whether we know the target variant. While the
  // status endpoint is still settling the title falls back to a generic
  // "Loading SAM".
  const title = variantHint
    ? `Switching to ${variantHint}`
    : status?.variant
      ? `Loading ${status.variant}`
      : "Loading SAM";

  // Subtitle: prefer real progress, fall back to "Initialising…" copy.
  const subtitle = hasRealProgress
    ? `Downloading ${variant}… ${formatBytes(progressBytes)} / ${formatBytes(progressTotal)}`
    : `Initialising ${variant}…`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="sam-loading-title"
      data-testid="model-loading-overlay"
      className="fixed inset-0 z-[900] flex items-center justify-center"
    >
      {/* Scrim — non-interactive; user dismisses via the Cancel button. */}
      <div
        aria-hidden
        className="absolute inset-0 bg-[rgba(15,23,42,0.32)] animate-confirm-fade-in"
      />
      <div
        className={cn(
          "relative z-[901] w-[min(92vw,460px)]",
          "rounded-[var(--radius-lg)]",
          "glass-surface-strong glass-specular",
          "p-6 outline-none",
          "animate-confirm-in",
        )}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close loading dialog"
          data-testid="model-loading-close"
          className={cn(
            "absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center",
            "rounded-[var(--radius-sm)] text-[color:var(--text-tertiary)]",
            "hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
          )}
        >
          <X className="h-4 w-4" />
        </button>

        <div className="grid gap-1 mb-4">
          <h2
            id="sam-loading-title"
            data-testid="model-loading-title"
            className="text-[16px] font-medium tracking-tight text-[color:var(--text-primary)] flex items-center gap-2"
          >
            <Loader2 className="h-4 w-4 animate-spin text-[color:var(--accent)]" />
            {title}
          </h2>
          <p
            data-testid="model-loading-subtitle"
            className="text-[13px] text-[color:var(--text-secondary)]"
          >
            {subtitle}
          </p>
        </div>

        {/* Progress bar — real percent when HF exposes it, indeterminate
            shimmer otherwise. The aria-valuenow is omitted in indeterminate
            mode per WAI-ARIA progressbar guidance. */}
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct ?? undefined}
          aria-label={subtitle}
          data-testid={
            hasRealProgress ? "model-loading-bar-determinate" : "model-loading-bar-indeterminate"
          }
          className={cn(
            "relative h-1.5 w-full overflow-hidden rounded-full",
            "bg-[var(--bg-subtle)]",
          )}
        >
          {hasRealProgress ? (
            <div
              className="absolute inset-y-0 left-0 bg-[var(--accent)] transition-[width] duration-300 ease-out"
              style={{ width: `${pct}%` }}
            />
          ) : (
            <div className="absolute inset-y-0 -left-1/3 w-1/3 bg-[var(--accent)] animate-[modelLoadingShimmer_1.4s_ease-in-out_infinite]" />
          )}
        </div>

        <p className="mt-3 text-[11.5px] text-[color:var(--text-tertiary)] leading-snug">
          The model is being loaded into GPU memory. This typically takes
          5-30 seconds. You can continue with other tools while you wait.
        </p>

        <div className="mt-6 flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            data-testid="model-loading-cancel"
          >
            Continue without waiting
          </Button>
        </div>
      </div>

      {/* Inline keyframes so we don't need a global.css change just for
          the indeterminate bar. Tailwind v4 inlines this fine. */}
      <style>{`
        @keyframes modelLoadingShimmer {
          0%   { transform: translateX(0%); }
          100% { transform: translateX(400%); }
        }
      `}</style>
    </div>
  );
}
