import { forwardRef, type HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const cardStyles = cva(["transition-all duration-200"], {
  variants: {
    variant: {
      surface:
        "bg-[var(--bg-surface)] border border-[var(--border-subtle)] shadow-[var(--shadow-elev-1)]",
      raised:
        "bg-[var(--bg-raised)] border border-[var(--border-subtle)] shadow-[var(--shadow-elev-2)]",
      glass:
        "bg-[var(--bg-glass)] backdrop-blur-md border border-[var(--border-subtle)] shadow-[var(--shadow-elev-2)]",
      "glass-strong":
        "bg-[var(--bg-glass-strong)] backdrop-blur-xl border border-[var(--border-subtle)] shadow-[var(--shadow-elev-3)]",
      sunken: "bg-[var(--bg-sunken)] border border-[var(--border-subtle)]",
    },
    radius: {
      sm: "rounded-[var(--radius-sm)]",
      md: "rounded-[var(--radius-md)]",
      lg: "rounded-[var(--radius-lg)]",
      xl: "rounded-[var(--radius-xl)]",
    },
    interactive: {
      true: "hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-elev-2)] hover:-translate-y-px",
      false: "",
    },
  },
  defaultVariants: {
    variant: "surface",
    radius: "lg",
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
