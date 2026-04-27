import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export function Kbd({ className, children, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center px-1.5",
        "rounded-[var(--radius-xs)] border border-[var(--border-subtle)]",
        "bg-[var(--bg-subtle)] text-[color:var(--text-tertiary)]",
        "font-mono text-[10px] font-medium leading-none",
        className,
      )}
      {...rest}
    >
      {children}
    </kbd>
  );
}
