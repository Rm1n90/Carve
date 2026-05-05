// Armin Mehri — mehri.armin@gmail.com
/**
 * Checkbox primitive — accessible native input wrapped in a styled box.
 *
 * Visual matches the input system: 16x16 box, var(--radius-xs) corners,
 * --bg-elev surface with --border-subtle border, --accent fill when
 * checked. Focus ring is the standard 2px var(--accent) box-shadow with
 * no border-color change. Optional `label` and `description` render a
 * row beside the box.
 */
import { Check } from "lucide-react";
import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: ReactNode;
  description?: ReactNode;
  /** Optional class for the outer label wrapper (when label/description present). */
  wrapperClassName?: string;
  /** Optional class for the visual box (16x16 element). */
  boxClassName?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  function Checkbox(
    {
      className,
      label,
      description,
      id,
      disabled,
      wrapperClassName,
      boxClassName,
      ...rest
    },
    ref,
  ) {
    const reactId = useId();
    const inputId = id ?? reactId;

    const box = (
      <span className={cn("relative inline-flex h-4 w-4 shrink-0", className)}>
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          disabled={disabled}
          className={cn(
            "peer absolute inset-0 h-full w-full cursor-pointer appearance-none m-0 opacity-0",
            "rounded-[var(--radius-xs,3px)]",
            disabled && "cursor-not-allowed",
          )}
          {...rest}
        />
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 flex h-4 w-4 items-center justify-center",
            "rounded-[var(--radius-xs,3px)] border border-[var(--border-subtle)] bg-[var(--bg-elev)]",
            "transition-[background-color,border-color,box-shadow] duration-[180ms] ease-out",
            "peer-hover:border-[var(--border-strong)]",
            "peer-focus-visible:shadow-[0_0_0_2px_var(--accent)]",
            "peer-checked:bg-[var(--accent)] peer-checked:border-[var(--accent)]",
            "peer-disabled:opacity-50 peer-disabled:cursor-not-allowed",
            boxClassName,
          )}
        />
        <Check
          aria-hidden="true"
          strokeWidth={3}
          className={cn(
            "pointer-events-none absolute inset-0 m-auto h-3 w-3 text-white opacity-0",
            "transition-opacity duration-[120ms]",
            "peer-checked:opacity-100",
          )}
        />
      </span>
    );

    if (!label && !description) {
      return box;
    }

    return (
      <label
        htmlFor={inputId}
        className={cn(
          "inline-flex items-start gap-2 cursor-pointer select-none",
          disabled && "cursor-not-allowed opacity-60",
          wrapperClassName,
        )}
      >
        {box}
        <span className="grid gap-0.5 leading-tight">
          {label && (
            <span className="text-[12.5px] text-[color:var(--text-primary)]">
              {label}
            </span>
          )}
          {description && (
            <span className="text-[11.5px] text-[color:var(--text-tertiary)]">
              {description}
            </span>
          )}
        </span>
      </label>
    );
  },
);
