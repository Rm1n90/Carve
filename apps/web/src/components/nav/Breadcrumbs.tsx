// Armin Mehri — mehri.armin@gmail.com
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Plan 14 Phase 8 Task 2 — generic breadcrumb trail for navigation
 * context. Each segment is either a clickable link or, for the
 * current/last segment, a non-link bold span.
 *
 * Segments are rendered in order. A segment is treated as the "current"
 * one (bold, no link) when ``to`` is omitted.
 */
export interface BreadcrumbSegment {
  label: ReactNode;
  /** Tanstack-router path. Omit for the current/last segment. */
  to?: string;
  /** Tanstack-router params for the segment's path. */
  params?: Record<string, string>;
  /** Optional explicit testid, useful in tests. */
  testId?: string;
}

interface BreadcrumbsProps {
  segments: BreadcrumbSegment[];
  className?: string;
}

export function Breadcrumbs({ segments, className }: BreadcrumbsProps) {
  return (
    <nav
      aria-label="Breadcrumb"
      data-testid="breadcrumbs"
      className={cn(
        "flex items-center gap-1 text-[12.5px] tracking-tight",
        className,
      )}
    >
      <ol className="flex items-center gap-1 list-none p-0 m-0">
        {segments.map((segment, idx) => {
          const isLast = idx === segments.length - 1;
          const isCurrent = isLast || segment.to === undefined;
          return (
            <Fragment key={`bc-${idx}-${segment.testId ?? "seg"}`}>
              <li className="inline-flex items-center">
                {isCurrent ? (
                  <span
                    aria-current="page"
                    data-testid={
                      segment.testId ?? `breadcrumb-segment-${idx}`
                    }
                    className="font-medium text-[color:var(--text-primary)] truncate max-w-[280px]"
                  >
                    {segment.label}
                  </span>
                ) : (
                  <Link
                    to={segment.to as never}
                    params={segment.params as never}
                    data-testid={
                      segment.testId ?? `breadcrumb-segment-${idx}`
                    }
                    className={cn(
                      "text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)]",
                      "transition-colors truncate max-w-[280px]",
                    )}
                  >
                    {segment.label}
                  </Link>
                )}
              </li>
              {!isLast && (
                <li
                  aria-hidden
                  className="text-[color:var(--text-tertiary)] grid place-items-center"
                >
                  <ChevronRight className="h-3 w-3" />
                </li>
              )}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
