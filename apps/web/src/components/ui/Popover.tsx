import * as PopoverPrimitive from "@radix-ui/react-popover";
import { forwardRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

interface PopoverContentProps {
  children: ReactNode;
  className?: string;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
}

export const PopoverContent = forwardRef<HTMLDivElement, PopoverContentProps>(
  function PopoverContent(
    { children, className, align = "end", side = "bottom", sideOffset = 6 },
    ref,
  ) {
    return (
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          ref={ref}
          align={align}
          side={side}
          sideOffset={sideOffset}
          className={cn(
            "z-[1000] min-w-[200px] rounded-[var(--radius-md)]",
            "glass-surface-strong p-1.5",
            "text-[color:var(--text-primary)]",
            "outline-none",
            className,
          )}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    );
  },
);
