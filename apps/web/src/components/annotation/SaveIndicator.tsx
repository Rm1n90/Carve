// Armin Mehri — mehri.armin@gmail.com
import { Loader2, AlertCircle, CheckCircle2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/cn";

interface SaveIndicatorProps {
  isSaving: boolean;
  hasError: boolean;
  dirtyCount: number;
  onRetry?: () => void;
}

/**
 * Pill rendered in the editor top bar reflecting save state.
 * "Saved" / "Unsaved changes" / "Saving" / "Save failed (retry)".
 */
export function SaveIndicator({ isSaving, hasError, dirtyCount, onRetry }: SaveIndicatorProps) {
  // v2.9 P1-17 — wrap each branch in role="status" + aria-live="polite"
  // so screen readers announce save transitions ("Saving…" → "Saved").
  // Mirrors SelectionCountBadge's a11y pattern.
  if (isSaving) {
    return (
      <span
        role="status"
        aria-live="polite"
        data-testid="save-indicator"
        data-state="saving"
        className={cn(
          "inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full",
          "bg-[var(--accent-bg)] text-[color:var(--accent)]",
          "text-[11.5px] font-medium tracking-tight",
        )}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        Saving…
      </span>
    );
  }
  if (hasError) {
    return (
      <button
        type="button"
        onClick={onRetry}
        role="status"
        aria-live="polite"
        data-testid="save-indicator"
        data-state="error"
        className={cn(
          "inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full",
          "bg-[var(--danger-bg)] text-[color:var(--danger)]",
          "text-[11.5px] font-medium tracking-tight",
          "hover:opacity-80 transition-opacity",
        )}
      >
        <AlertCircle className="h-3 w-3" />
        Save failed
        <RefreshCw className="h-3 w-3 ml-0.5" />
      </button>
    );
  }
  if (dirtyCount > 0) {
    return (
      <span
        role="status"
        aria-live="polite"
        data-testid="save-indicator"
        data-state="dirty"
        className={cn(
          "inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full",
          "bg-[var(--warning-bg)] text-[var(--warning)]",
          "text-[11.5px] font-medium tracking-tight",
        )}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-[#D97706] animate-pulse" />
        Unsaved changes
      </span>
    );
  }
  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="save-indicator"
      data-state="saved"
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full",
        "glass-chip text-[color:var(--text-tertiary)]",
        "text-[11.5px] font-medium tracking-tight",
      )}
    >
      <CheckCircle2 className="h-3 w-3 text-[color:var(--success)]" />
      Saved
    </span>
  );
}
