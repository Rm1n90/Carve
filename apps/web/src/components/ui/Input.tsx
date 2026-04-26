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
          className="text-[12px] uppercase tracking-[0.08em] text-tertiary font-medium"
        >
          {label}
        </label>
      )}
      <div className="relative">
        {leftIcon && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-tertiary pointer-events-none">
            {leftIcon}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : hint ? hintId : undefined}
          className={cn(
            "w-full h-10 rounded-[var(--radius-md)]",
            "bg-[var(--bg-sunken)] text-primary placeholder:text-tertiary",
            "border border-[var(--border-subtle)]",
            "px-3.5 py-2 text-[14px]",
            "transition-colors duration-150",
            "hover:border-[var(--border-strong)]",
            "focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[oklch(0.78_0.16_215_/_0.25)]",
            "disabled:opacity-40 disabled:cursor-not-allowed",
            leftIcon && "pl-10",
            rightIcon && "pr-10",
            error &&
              "border-[var(--danger)] focus:border-[var(--danger)] focus:ring-[oklch(0.70_0.20_25_/_0.25)]",
            className,
          )}
          {...rest}
        />
        {rightIcon && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-tertiary">
            {rightIcon}
          </span>
        )}
      </div>
      {hint && !error && (
        <p id={hintId} className="text-[12px] text-tertiary">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-[12px] text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
});
