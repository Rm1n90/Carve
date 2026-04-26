import { forwardRef, type HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const badgeStyles = cva(
  [
    "inline-flex items-center gap-1.5 whitespace-nowrap",
    "font-medium tracking-tight border",
  ],
  {
    variants: {
      variant: {
        accent:
          "bg-[var(--accent-bg)] text-[var(--accent)] border-[var(--border-accent)]",
        success:
          "bg-[oklch(0.78_0.16_145_/_0.10)] text-[var(--success)] border-[oklch(0.78_0.16_145_/_0.35)]",
        warning:
          "bg-[oklch(0.84_0.17_75_/_0.12)] text-[var(--warning)] border-[oklch(0.84_0.17_75_/_0.40)]",
        danger:
          "bg-[oklch(0.70_0.20_25_/_0.12)] text-[var(--danger)] border-[oklch(0.70_0.20_25_/_0.40)]",
        neutral:
          "bg-[var(--bg-raised)] text-secondary border-[var(--border-subtle)]",
        ghost: "bg-transparent text-tertiary border-[var(--border-subtle)]",
      },
      size: {
        sm: "h-5 px-2 text-[10px] rounded-full uppercase tracking-[0.08em]",
        md: "h-6 px-2.5 text-[11px] rounded-full",
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
