// Armin Mehri — mehri.armin@gmail.com
import { forwardRef, type HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

// DESIGN.md §5 — inline tag spans use 20px radius; status pills go full
// 999px. Border colours are derived from the same accent/success/warning/
// danger token families rather than hardcoded hexes, so every theme stays
// in sync with the palette.
const badgeStyles = cva(
  [
    "inline-flex items-center gap-1 whitespace-nowrap",
    "font-medium tracking-tight border",
    "transition-colors duration-[180ms] ease-out",
  ],
  {
    variants: {
      variant: {
        accent:
          "bg-[var(--accent-bg)] text-[color:var(--accent)] border-[var(--accent-bg-hover)]",
        success:
          "bg-[var(--success-bg)] text-[color:var(--success)] border-[var(--success-bg)]",
        warning:
          "bg-[var(--warning-bg)] text-[color:var(--warning)] border-[var(--warning-bg)]",
        danger:
          "bg-[var(--danger-bg)] text-[color:var(--danger)] border-[var(--danger-bg)]",
        neutral:
          "bg-[var(--bg-subtle)] text-[color:var(--text-secondary)] border-[var(--border-subtle)]",
        ghost: "bg-transparent text-[color:var(--text-tertiary)] border-[var(--border-subtle)]",
      },
      size: {
        sm: "h-5 px-2 text-[10px] rounded-[var(--radius-pill)]",
        md: "h-6 px-2.5 text-[11px] rounded-[var(--radius-pill)]",
      },
    },
    defaultVariants: {
      variant: "neutral",
      size: "sm",
    },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeStyles> {}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, variant, size, ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(badgeStyles({ variant, size }), className)}
      {...rest}
    />
  );
});
