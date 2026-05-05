// Armin Mehri — mehri.armin@gmail.com
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export const TooltipProvider = TooltipPrimitive.Provider;

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  delayDuration?: number;
  className?: string;
}

export function Tooltip({
  content,
  children,
  side = "top",
  align = "center",
  delayDuration = 200,
  className,
}: TooltipProps) {
  return (
    <TooltipPrimitive.Root delayDuration={delayDuration}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={6}
          className={cn(
            // DESIGN.md §1 — solid surface; tooltips stay tight (3px
            // input-tier radius) and use the lightweight tile shadow
            // so they read as "close to the cursor" rather than a
            // lifted modal.
            "z-[1000] px-2 py-1",
            "rounded-[var(--radius-3)]",
            "bg-[var(--bg-elev)] border border-[var(--border-subtle)]",
            "shadow-[var(--shadow-tile)] text-[color:var(--text-primary)]",
            "text-[11px] font-medium tracking-tight",
            className,
          )}
        >
          {content}
          <TooltipPrimitive.Arrow
            className="fill-[var(--bg-elev)]"
            width={10}
            height={5}
          />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
