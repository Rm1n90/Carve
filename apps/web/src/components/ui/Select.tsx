// Armin Mehri — mehri.armin@gmail.com
/**
 * v3.0 — Select primitive (glass).
 *
 * Reusable dropdown built on `@radix-ui/react-select`. Replaces the plain
 * HTML `<select>`s in NewTaskDialog (Kind), ExportDialog (Format), and
 * ImportDialog (Format), which had no v2.8 glass treatment.
 *
 * Compound API:
 *
 *   <Select value={value} onValueChange={onChange}>
 *     <Select.Trigger aria-label="kind">
 *       <Select.Value />
 *     </Select.Trigger>
 *     <Select.Content>
 *       <Select.Item value="image">Image set</Select.Item>
 *       <Select.Item value="video">Video</Select.Item>
 *     </Select.Content>
 *   </Select>
 *
 * Visuals:
 *   • Trigger: glass-chip background, hairline glass border, chevron.
 *   • Content: glass-surface-strong portal, rounded-lg, 4px padding.
 *   • Items: hover bg --accent-bg, active bg --accent-bg-hover.
 */
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { forwardRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";

interface SelectRootProps {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
  disabled?: boolean;
}

function SelectRoot({ value, onValueChange, children, disabled }: SelectRootProps) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      {children}
    </SelectPrimitive.Root>
  );
}

interface SelectTriggerProps {
  children?: ReactNode;
  className?: string;
  "aria-label"?: string;
  /** Optional test hook for callers that want a stable selector. */
  "data-testid"?: string;
}

const SelectTrigger = forwardRef<HTMLButtonElement, SelectTriggerProps>(
  function SelectTrigger({ children, className, ...rest }, ref) {
    return (
      <SelectPrimitive.Trigger
        ref={ref}
        className={cn(
          "inline-flex h-8 items-center justify-between gap-2",
          // DESIGN.md §4 — Select trigger is an input, so it gets the
          // 3px input radius and the 2px PS-blue focus ring (no
          // border-color change). Solid surface — no glass on form
          // controls per DESIGN.md §1.
          "rounded-[var(--radius-3)] px-2.5",
          "border border-[var(--border-subtle)] bg-[var(--bg-elev)]",
          "text-[12.5px] text-[color:var(--text-primary)]",
          "transition-[border-color,box-shadow] duration-[180ms] ease-out",
          "hover:border-[var(--border-strong)]",
          "focus:outline-none focus:shadow-[0_0_0_2px_var(--accent)]",
          "data-[state=open]:shadow-[0_0_0_2px_var(--accent)]",
          "disabled:opacity-60 disabled:cursor-not-allowed",
          className,
        )}
        {...rest}
      >
        <span className="truncate">{children ?? <SelectPrimitive.Value />}</span>
        <SelectPrimitive.Icon asChild>
          <ChevronDown className="h-3.5 w-3.5 text-[color:var(--text-tertiary)]" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
    );
  },
);

const SelectValue = SelectPrimitive.Value;

interface SelectContentProps {
  children: ReactNode;
  className?: string;
}

const SelectContent = forwardRef<HTMLDivElement, SelectContentProps>(
  function SelectContent({ children, className }, ref) {
    return (
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          ref={ref}
          position="popper"
          sideOffset={4}
          // Collision-aware sizing: Radix exposes the available height
          // (vertical room from trigger to viewport edge) via the CSS
          // var below. Without this the dropdown happily extends past
          // the editor's viewport and the bottom-most options are
          // unreachable — the bug Armin reported for the Filter dialog
          // when many classes exist.
          className={cn(
            "z-[1200] min-w-[var(--radix-select-trigger-width)]",
            "max-h-[var(--radix-select-content-available-height)]",
            // DESIGN.md §1 — no glass on form controls; solid panel
            // with the standard card-tier shadow. 6px radius keeps the
            // popover compact and matches §5's "compact buttons and
            // inline images" tier.
            "overflow-hidden rounded-[var(--radius-6)] p-1",
            "bg-[var(--bg-elev)] border border-[var(--border-subtle)]",
            "shadow-[var(--shadow-card)]",
            className,
          )}
        >
          {/*
           * Viewport owns the scroll. ``max-h-full`` lets it stretch to
           * the Content's collision-aware max-height; overflow-y-auto
           * gives the user a normal scroll path for long class lists.
           */}
          <SelectPrimitive.Viewport
            className="max-h-full overflow-y-auto"
          >
            {children}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    );
  },
);

interface SelectItemProps {
  value: string;
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
  // v3.25 — Radix Select supports per-item disabling; pass-through.
  disabled?: boolean;
  title?: string;
}

const SelectItem = forwardRef<HTMLDivElement, SelectItemProps>(
  function SelectItem({ value, children, className, ...rest }, ref) {
    return (
      <SelectPrimitive.Item
        ref={ref}
        value={value}
        className={cn(
          "relative flex h-8 cursor-pointer select-none items-center",
          "rounded-[var(--radius-sm)] px-2 pr-7",
          "text-[12.5px] text-[color:var(--text-primary)] outline-none",
          "data-[highlighted]:bg-[var(--accent-bg)]",
          "data-[state=checked]:bg-[var(--accent-bg-hover)]",
          "data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed",
          className,
        )}
        {...rest}
      >
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        <SelectPrimitive.ItemIndicator className="absolute right-1.5 inline-flex items-center">
          <Check className="h-3.5 w-3.5 text-[color:var(--accent)]" />
        </SelectPrimitive.ItemIndicator>
      </SelectPrimitive.Item>
    );
  },
);

interface SelectExports {
  Trigger: typeof SelectTrigger;
  Value: typeof SelectValue;
  Content: typeof SelectContent;
  Item: typeof SelectItem;
}

export const Select: typeof SelectRoot & SelectExports = Object.assign(SelectRoot, {
  Trigger: SelectTrigger,
  Value: SelectValue,
  Content: SelectContent,
  Item: SelectItem,
});
