// Armin Mehri — mehri.armin@gmail.com
/**
 * Switch primitive — toggle built on a hidden native checkbox.
 *
 * 28x16 track, 12x12 thumb. Off track is --bg-subtle, on track is
 * --accent. Thumb slides with a 180ms ease-out. Focus ring is the
 * standard 2px var(--accent) box-shadow on the track.
 */
import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";

export interface SwitchProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: ReactNode;
  description?: ReactNode;
  /** Optional class for the outer label wrapper (when label/description present). */
  wrapperClassName?: string;
  /** Optional class for the visual track. */
  trackClassName?: string;
}

export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  {
    className,
    label,
    description,
    id,
    disabled,
    wrapperClassName,
    trackClassName,
    ...rest
  },
  ref,
) {
  const reactId = useId();
  const inputId = id ?? reactId;

  const toggle = (
    <span
      className={cn(
        "relative inline-flex h-4 w-7 shrink-0 items-center",
        className,
      )}
    >
      <input
        ref={ref}
        id={inputId}
        type="checkbox"
        role="switch"
        disabled={disabled}
        className={cn(
          "peer absolute inset-0 h-full w-full cursor-pointer appearance-none m-0 opacity-0",
          disabled && "cursor-not-allowed",
        )}
        {...rest}
      />
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 h-4 w-7 rounded-full",
          "bg-[var(--bg-subtle)] border border-[var(--border-subtle)]",
          "transition-[background-color,border-color,box-shadow] duration-[180ms] ease-out",
          "peer-hover:border-[var(--border-strong)]",
          "peer-focus-visible:shadow-[0_0_0_2px_var(--accent)]",
          "peer-checked:bg-[var(--accent)] peer-checked:border-[var(--accent)]",
          "peer-disabled:opacity-50 peer-disabled:cursor-not-allowed",
          trackClassName,
        )}
      />
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute left-0.5 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-white",
          "shadow-sm transition-transform duration-[180ms] ease-out",
          "peer-checked:translate-x-3",
        )}
      />
    </span>
  );

  if (!label && !description) {
    return toggle;
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
      {toggle}
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
});
