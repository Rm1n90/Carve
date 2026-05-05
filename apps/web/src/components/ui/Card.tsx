import { forwardRef, type HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

/**
 * DESIGN.md §4 / §6 surface card.
 *
 * Variants map to PlayStation's elevation language:
 *   - surface  → no shadow (default content on bg-elev)
 *   - tile     → 0.08 shadow, the standard grid-tile elevation
 *   - feature  → 0.16 shadow, used on hover or for emphasised cards
 *   - hero     → 0.8 shadow, only when a card overlaps photography
 *   - sunken   → atmospheric inset on the subtle surface tier
 *
 * Radius is the full DESIGN.md §5 scale: 6 (compact), 12 (media),
 * 19 (feature card), 24 (hero). Legacy sm/md/lg/xl tokens are kept
 * for callsites that haven't migrated yet.
 *
 * No glassmorphism — DESIGN.md §1 reserves glass for the Filter Mist
 * sticky-bar moment only.
 */
const cardStyles = cva(
  ["transition-[border-color,background-color,box-shadow,transform] duration-[180ms] ease-out"],
  {
    variants: {
      variant: {
        surface: "bg-[var(--bg-elev)] border border-[var(--border-subtle)]",
        tile:
          "bg-[var(--bg-elev)] border border-[var(--border-subtle)] shadow-[var(--shadow-tile)]",
        feature:
          "bg-[var(--bg-elev)] border border-[var(--border-subtle)] shadow-[var(--shadow-card)]",
        hero:
          "bg-[var(--bg-elev)] border border-[var(--border-subtle)] shadow-[var(--shadow-hero)]",
        sunken: "bg-[var(--bg-subtle)] border border-[var(--border-subtle)]",
        // Legacy aliases — kept so existing callsites keep working.
        raised:
          "bg-[var(--bg-elev)] border border-[var(--border-subtle)] shadow-[var(--shadow-feather)]",
        glass:
          "bg-[var(--bg-elev)] border border-[var(--border-subtle)] shadow-[var(--shadow-feather)]",
        "glass-strong":
          "bg-[var(--bg-elev)] border border-[var(--border-subtle)] shadow-[var(--shadow-tile)]",
      },
      radius: {
        // DESIGN.md §5 canonical scale.
        compact: "rounded-[var(--radius-6)]",
        media: "rounded-[var(--radius-12)]",
        feature: "rounded-[var(--radius-19)]",
        hero: "rounded-[var(--radius-24)]",
        // Legacy aliases.
        sm: "rounded-[var(--radius-sm)]",
        md: "rounded-[var(--radius-md)]",
        lg: "rounded-[var(--radius-lg)]",
        xl: "rounded-[var(--radius-xl)]",
      },
      interactive: {
        true: "hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-card)] cursor-pointer",
        false: "",
      },
    },
    defaultVariants: {
      variant: "surface",
      radius: "md",
      interactive: false,
    },
  },
);

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
