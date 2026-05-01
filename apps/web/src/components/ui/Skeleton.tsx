/**
 * Tasteful loading skeleton used as a Suspense fallback for lazily
 * loaded route components. Keeps the visual language consistent with the
 * rest of the editorial layout — muted typography, centered spinner,
 * a small caption explaining what is loading.
 */
import { Loader2 } from "lucide-react";

export interface SkeletonProps {
  /** Short label rendered under the spinner, e.g. "Loading editor…". */
  label?: string;
}

export function Skeleton({ label = "Loading…" }: SkeletonProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="route-skeleton"
      className="grid min-h-[60vh] place-items-center"
    >
      <div className="grid gap-3 place-items-center text-center">
        <Loader2
          aria-hidden
          className="h-6 w-6 animate-spin text-[color:var(--text-tertiary)]"
        />
        <span className="font-mono text-[11px] tracking-[0.18em] uppercase text-[color:var(--text-tertiary)]">
          {label}
        </span>
      </div>
    </div>
  );
}
