// Armin Mehri — mehri.armin@gmail.com
/**
 * Textarea primitive — multi-line input that mirrors `Input.tsx`'s
 * surface, border, focus ring, and label/hint/error structure.
 *
 * Default min-height is 88px so it never collapses to a single line.
 */
import {
  forwardRef,
  useId,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/cn";

export interface TextareaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ className, label, hint, error, id, ...rest }, ref) {
    const reactId = useId();
    const textareaId = id ?? reactId;
    const hintId = `${textareaId}-hint`;
    const errorId = `${textareaId}-error`;

    return (
      <div className="grid gap-1.5">
        {label && (
          <label
            htmlFor={textareaId}
            className="text-[12px] tracking-tight text-[color:var(--text-secondary)] font-medium"
          >
            {label}
          </label>
        )}
        <textarea
          ref={ref}
          id={textareaId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : hint ? hintId : undefined}
          className={cn(
            "w-full min-h-[88px] rounded-[var(--radius-3)]",
            "bg-[var(--bg-elev)] text-[color:var(--text-primary)] placeholder:text-[color:var(--text-tertiary)]",
            "border border-[var(--border-subtle)]",
            "px-3 py-2 text-[13px] leading-snug",
            "transition-[border-color,box-shadow] duration-[180ms] ease-out",
            "hover:border-[var(--border-strong)]",
            "focus:outline-none focus:shadow-[0_0_0_2px_var(--accent)]",
            "disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-[var(--bg-hover)]",
            "resize-y",
            error &&
              "border-[var(--danger)] focus:shadow-[0_0_0_2px_var(--danger)]",
            className,
          )}
          {...rest}
        />
        {hint && !error && (
          <p
            id={hintId}
            className="text-[12px] text-[color:var(--text-tertiary)]"
          >
            {hint}
          </p>
        )}
        {error && (
          <p
            id={errorId}
            role="alert"
            className="text-[12px] text-[color:var(--danger)]"
          >
            {error}
          </p>
        )}
      </div>
    );
  },
);
