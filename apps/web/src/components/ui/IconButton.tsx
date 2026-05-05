// Armin Mehri — mehri.armin@gmail.com
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

// DESIGN.md §4 Buttons — Icon Circle variant is genuinely circular at
// 100% radius. The "primary" variant carries the same hover signature as
// the main Button: cyan fill swap, 2px white border, 2px PS-blue ring,
// 1.05× lift, 180ms ease.
const iconButtonStyles = cva(
  [
    "inline-flex items-center justify-center",
    "transition-all duration-[180ms] ease-out",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
    "disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none",
    "border",
  ],
  {
    variants: {
      variant: {
        default: [
          "bg-transparent text-[color:var(--text-secondary)] border-transparent",
          "hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
        ],
        active: [
          "bg-[var(--accent-bg)] text-[color:var(--accent)] border-[var(--accent-bg-hover)]",
          "hover:bg-[var(--accent-bg-hover)]",
        ],
        ghost: [
          "bg-transparent text-[color:var(--text-tertiary)] border-transparent",
          "hover:text-[color:var(--text-primary)] hover:bg-[var(--bg-hover)]",
        ],
        outline: [
          "bg-[var(--bg-elev)] text-[color:var(--text-secondary)] border-[var(--border-subtle)]",
          "hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)] hover:border-[var(--border-strong)]",
        ],
        // v2.9 audit P1-6 — for IconButtons sitting inside glass surfaces
        // (e.g. AssetNavControls chevrons inside the glass TopBar). Reuses
        // the .glass-chip utility so the button reads as a translucent
        // pill rather than an opaque island.
        glass: [
          "glass-chip text-[color:var(--text-secondary)] border-transparent",
          "hover:text-[color:var(--text-primary)]",
        ],
        // DESIGN.md §4 — primary icon button gets the full PS hover
        // signature. Use this on prominent toolbar actions.
        primary: [
          "bg-[var(--accent)] text-[color:var(--accent-fg)] border-[var(--accent)]",
          "hover:bg-[var(--accent-hover)] hover:border-white",
          "hover:shadow-[0_0_0_2px_var(--accent)] hover:scale-[1.05]",
          "active:opacity-60 active:scale-100",
        ],
      },
      size: {
        xs: "h-6 w-6 rounded-[var(--radius-sm)]",
        sm: "h-7 w-7 rounded-[var(--radius-sm)]",
        md: "h-8 w-8 rounded-[var(--radius-md)]",
        lg: "h-10 w-10 rounded-[var(--radius-md)]",
        // DESIGN.md §4 — Icon Circle. Reach for this when the button
        // sits over photography (carousel arrows, share, close).
        circle: "h-10 w-10 rounded-[var(--radius-pill)]",
        circleSm: "h-8 w-8 rounded-[var(--radius-pill)]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  },
);

export interface IconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof iconButtonStyles> {
  /** Required for accessibility — always pass an aria-label. */
  "aria-label": string;
  children: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ className, variant, size, type = "button", children, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(iconButtonStyles({ variant, size }), className)}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
