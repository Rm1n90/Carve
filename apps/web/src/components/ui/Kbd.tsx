import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export function Kbd({ className, children, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-[20px] items-center justify-center px-1.5",
        "rounded-[4px] border border-[var(--border-strong)]",
        "bg-[var(--bg-raised)] text-tertiary",
        "font-mono text-[10.5px] font-medium leading-none",
        "shadow-[inset_0_-1px_0_oklch(0_0_0_/_0.4)]",
        className,
      )}
      {...rest}
    >
      {children}
    </kbd>
  );
}
