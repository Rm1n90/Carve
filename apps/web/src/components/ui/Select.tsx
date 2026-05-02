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
          "rounded-[var(--radius-sm)] px-2.5",
          "border border-[var(--glass-border)] bg-[var(--glass-chip-bg)]",
          "text-[12.5px] text-[color:var(--text-primary)]",
          "hover:border-[var(--border-strong)]",
          "focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
          "data-[state=open]:border-[var(--accent)]",
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
          className={cn(
            "z-[1200] min-w-[var(--radix-select-trigger-width)]",
            "overflow-hidden rounded-[var(--radius-lg)] p-1",
            "glass-surface-strong glass-specular",
            "shadow-[var(--shadow-elev-2)]",
            className,
          )}
        >
          <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
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
