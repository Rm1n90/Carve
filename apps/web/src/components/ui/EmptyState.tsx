// Armin Mehri — mehri.armin@gmail.com
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

/**
 * Plan 14 Phase 8 Task 10 — composable empty state.
 *
 * Editorial / refined aesthetic — title in Fraunces (small display),
 * description in Geist body, CTA via the existing primary <Button>.
 * Centered layout with generous whitespace, dashed muted card surface
 * built from the existing oklch tokens (no new colors).
 */
export interface EmptyStateProps {
  /** Optional lucide-react icon (e.g. ``<FolderPlus />``) rendered above the title. */
  icon?: ReactNode;
  title: string;
  description?: string;
  cta?: {
    label: string;
    onClick?: () => void;
    href?: string;
  };
  /**
   * ``"default"`` — full whitespace empty state suitable for an entire
   * page region.
   * ``"compact"`` — tighter padding for inline / sub-list empty states.
   */
  variant?: "default" | "compact";
  /** Optional explicit testid override; defaults to ``empty-state``. */
  testId?: string;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  cta,
  variant = "default",
  testId,
  className,
}: EmptyStateProps) {
  const isCompact = variant === "compact";
  return (
    <div
      data-testid={testId ?? "empty-state"}
      data-variant={variant}
      role="status"
      className={cn(
        "grid place-items-center text-center",
        "rounded-[var(--radius-lg)] border border-dashed border-[var(--border-subtle)]",
        "bg-[var(--bg-subtle)]",
        isCompact ? "px-5 py-6 gap-2" : "px-6 py-14 gap-3",
        className,
      )}
    >
      {icon ? (
        <span
          aria-hidden
          data-testid="empty-state-icon"
          className={cn(
            "grid place-items-center text-[color:var(--text-tertiary)]",
            isCompact ? "h-5 w-5" : "h-7 w-7",
          )}
        >
          {icon}
        </span>
      ) : null}

      <h3
        data-testid="empty-state-title"
        className={cn(
          "font-editorial leading-[1.1] text-[color:var(--text-primary)]",
          isCompact
            ? "text-[16px] tracking-tight"
            : "text-[22px] tracking-tight",
        )}
      >
        {title}
      </h3>

      {description ? (
        <p
          data-testid="empty-state-description"
          className={cn(
            "max-w-[44ch] text-[color:var(--text-secondary)] leading-snug",
            isCompact ? "text-[12px]" : "text-[13px]",
          )}
        >
          {description}
        </p>
      ) : null}

      {cta ? (
        <div className={cn("mt-1", isCompact && "mt-0.5")}>
          {cta.href ? (
            <a
              href={cta.href}
              data-testid="empty-state-cta"
              className={cn(
                "inline-flex items-center justify-center rounded-[var(--radius-sm)]",
                "bg-[var(--accent)] text-[color:var(--accent-fg)] font-medium tracking-tight",
                "hover:opacity-90 transition-opacity",
                isCompact ? "h-8 px-3 text-[12.5px]" : "h-9 px-4 text-[13px]",
              )}
            >
              {cta.label}
            </a>
          ) : (
            <Button
              data-testid="empty-state-cta"
              variant="primary"
              size={isCompact ? "sm" : "md"}
              onClick={cta.onClick}
            >
              {cta.label}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
