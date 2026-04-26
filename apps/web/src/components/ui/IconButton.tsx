import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const iconButtonStyles = cva(
  [
    "inline-flex items-center justify-center",
    "transition-all duration-150 ease-[cubic-bezier(0.16,1,0.3,1)]",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
    "disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none",
    "border",
  ],
  {
    variants: {
      variant: {
        default: [
          "bg-transparent text-[var(--text-secondary)] border-transparent",
          "hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)] hover:border-[var(--border-subtle)]",
        ],
        active: [
          "bg-[var(--accent-bg)] text-[var(--accent)] border-[var(--border-accent)]",
          "shadow-[0_0_0_1px_var(--border-accent),_0_0_18px_oklch(0.78_0.16_215_/_0.18)]",
          "hover:bg-[var(--accent-bg-hover)]",
        ],
        ghost: [
          "bg-transparent text-[var(--text-tertiary)] border-transparent",
          "hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)]",
        ],
      },
      size: {
        sm: "h-8 w-8 rounded-[var(--radius-sm)]",
        md: "h-10 w-10 rounded-[var(--radius-md)]",
        lg: "h-12 w-12 rounded-[var(--radius-md)]",
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
