import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

const buttonStyles = cva(
  [
    "inline-flex items-center justify-center gap-2",
    "font-medium tracking-tight whitespace-nowrap select-none",
    "transition-all duration-150 ease-[cubic-bezier(0.16,1,0.3,1)]",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
    "disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none",
    "border",
  ],
  {
    variants: {
      variant: {
        primary: [
          "bg-[var(--accent)] text-[var(--accent-fg)] border-[var(--accent)]",
          "hover:bg-[var(--accent-hover)] active:bg-[var(--accent-active)]",
          "shadow-[var(--shadow-elev-1)]",
        ],
        secondary: [
          "bg-[var(--bg-raised)] text-[var(--text-primary)] border-[var(--border-subtle)]",
          "hover:bg-[var(--bg-surface)] hover:border-[var(--border-strong)]",
        ],
        ghost: [
          "bg-transparent text-[var(--text-secondary)] border-transparent",
          "hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]",
        ],
        danger: [
          "bg-[oklch(0.70_0.20_25_/_0.12)] text-[var(--danger)] border-[oklch(0.70_0.20_25_/_0.4)]",
          "hover:bg-[oklch(0.70_0.20_25_/_0.20)] hover:border-[var(--danger)]",
        ],
      },
      size: {
        sm: "h-8 px-3 text-[13px] rounded-[var(--radius-sm)]",
        md: "h-10 px-4 text-[14px] rounded-[var(--radius-md)]",
        lg: "h-12 px-6 text-[15px] rounded-[var(--radius-md)]",
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
