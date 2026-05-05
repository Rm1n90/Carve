// Armin Mehri — mehri.armin@gmail.com
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

const buttonStyles = cva(
  [
    "inline-flex items-center justify-center gap-2",
    "font-medium tracking-tight whitespace-nowrap select-none",
    // DESIGN.md §1 — signature interaction is a 180ms ease across
    // background, transform, border, and shadow. We keep transition-all
    // here so the hover ring + scale animate together with the color swap.
    "transition-all duration-[180ms] ease-out",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
    "disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none",
    "border",
  ],
  {
    variants: {
      variant: {
        // DESIGN.md §4 — primary CTA carries the full PlayStation hover
        // signature: cyan fill swap, 2px white border, 2px blue outer
        // ring, and a 1.05× lift (damped from DESIGN.md's 1.2× because
        // these buttons live in dense in-app toolbars; hero/marketing
        // surfaces use .ps-pill--bold to opt back into the literal 1.2×).
        primary: [
          "bg-[var(--accent)] text-[color:var(--accent-fg)] border-[var(--accent)]",
          "hover:bg-[var(--accent-hover)] hover:border-white",
          "hover:shadow-[0_0_0_2px_var(--accent)] hover:scale-[1.05]",
          "active:opacity-60 active:scale-100",
        ],
        // Quiet button — transparent surface + subtle border.
        secondary: [
          "bg-transparent text-[color:var(--text-primary)] border-[var(--border-subtle)]",
          "hover:bg-[var(--bg-hover)] hover:border-[var(--border-strong)]",
        ],
        ghost: [
          "bg-transparent text-[color:var(--text-secondary)] border-transparent",
          "hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
        ],
        // Reserved for "commit" actions only — Save, Build, Commit final.
        success: [
          "bg-[var(--success)] text-[color:var(--success-fg)] border-[var(--success)]",
          "hover:bg-[var(--success-hover)] hover:border-[var(--success-hover)]",
          "active:bg-[var(--success-active)]",
        ],
        danger: [
          "bg-transparent text-[color:var(--danger)] border-[var(--border-subtle)]",
          "hover:bg-[var(--danger-bg)] hover:border-[var(--danger)]",
        ],
      },
      size: {
        sm: "h-7 px-2.5 text-[12px] rounded-[var(--radius-sm)]",
        md: "h-9 px-3.5 text-[13px] rounded-[var(--radius-md)]",
        lg: "h-10 px-4 text-[14px] rounded-[var(--radius-md)]",
      },
      block: {
        true: "w-full",
        false: "",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "md",
      block: false,
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonStyles> {
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant,
    size,
    block,
    loading,
    leftIcon,
    rightIcon,
    disabled,
    children,
    type = "button",
    ...rest
  },
  ref,
) {
  const isDisabled = disabled || loading;
  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cn(buttonStyles({ variant, size, block }), className)}
      {...rest}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {!loading && leftIcon && <span className="-ml-0.5 flex items-center">{leftIcon}</span>}
      <span>{children}</span>
      {!loading && rightIcon && <span className="-mr-0.5 flex items-center">{rightIcon}</span>}
    </button>
  );
});
