// Armin Mehri — mehri.armin@gmail.com
import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, label, hint, error, id, leftIcon, rightIcon, ...rest },
  ref,
) {
  const reactId = useId();
  const inputId = id ?? reactId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;

  return (
    <div className="grid gap-1.5">
      {label && (
        <label
          htmlFor={inputId}
          className="text-[12px] tracking-tight text-[color:var(--text-secondary)] font-medium"
        >
          {label}
        </label>
      )}
      <div className="relative">
        {leftIcon && (
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[color:var(--text-tertiary)] pointer-events-none">
            {leftIcon}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : hint ? hintId : undefined}
          className={cn(
            "w-full h-9 rounded-[var(--radius-md)]",
            "bg-[var(--bg-elev)] text-[color:var(--text-primary)] placeholder:text-[color:var(--text-tertiary)]",
            "border border-[var(--border-subtle)]",
            "px-3 py-2 text-[13px]",
            "transition-colors duration-150",
            "hover:border-[var(--border-strong)]",
            "focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[rgba(99,102,241,0.18)]",
            "disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-[var(--bg-hover)]",
            leftIcon && "pl-9",
            rightIcon && "pr-9",
            error &&
              "border-[var(--danger)] focus:border-[var(--danger)] focus:ring-[rgba(220,38,38,0.18)]",
            className,
          )}
          {...rest}
        />
        {rightIcon && (
          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[color:var(--text-tertiary)]">
            {rightIcon}
          </span>
        )}
      </div>
      {hint && !error && (
        <p id={hintId} className="text-[12px] text-[color:var(--text-tertiary)]">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-[12px] text-[color:var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
});
