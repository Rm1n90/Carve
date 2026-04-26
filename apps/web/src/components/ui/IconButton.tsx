import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const iconButtonStyles = cva(
  [
    "inline-flex items-center justify-center",
    "transition-colors duration-150",
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
      },
      size: {
        xs: "h-6 w-6 rounded-[var(--radius-sm)]",
        sm: "h-7 w-7 rounded-[var(--radius-sm)]",
        md: "h-8 w-8 rounded-[var(--radius-md)]",
        lg: "h-10 w-10 rounded-[var(--radius-md)]",
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
