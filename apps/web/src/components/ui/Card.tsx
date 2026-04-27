import { forwardRef, type HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

/**
 * Flat surface card. No glassmorphism. Subtle border + optional 1px shadow.
 * Variants kept for legacy callsites; all map to the same flat appearance.
 */
const cardStyles = cva(["transition-colors duration-150"], {
  variants: {
    variant: {
      surface: "bg-[var(--bg-elev)] border border-[var(--border-subtle)]",
      raised:
        "bg-[var(--bg-elev)] border border-[var(--border-subtle)] shadow-[var(--shadow-elev-1)]",
      glass: "bg-[var(--bg-elev)] border border-[var(--border-subtle)]",
      "glass-strong":
        "bg-[var(--bg-elev)] border border-[var(--border-subtle)] shadow-[var(--shadow-elev-1)]",
      sunken: "bg-[var(--bg-subtle)] border border-[var(--border-subtle)]",
    },
    radius: {
      sm: "rounded-[var(--radius-sm)]",
      md: "rounded-[var(--radius-md)]",
      lg: "rounded-[var(--radius-lg)]",
      xl: "rounded-[var(--radius-xl)]",
    },
    interactive: {
      true: "hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] cursor-pointer",
      false: "",
    },
  },
  defaultVariants: {
    variant: "surface",
    radius: "md",
    interactive: false,
  },
});

export interface CardProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardStyles> {}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, variant, radius, interactive, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(cardStyles({ variant, radius, interactive }), className)}
      {...rest}
    />
  );
});
