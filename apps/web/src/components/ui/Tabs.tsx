// Armin Mehri — mehri.armin@gmail.com
/**
 * Tabs primitive — Radix-backed, two visual variants.
 *
 *   underline  default. inset hairline rail with a 2px PS-blue indicator
 *              under the active label. Body type, no chrome on the trigger.
 *              For surfaces where tabs sit directly on the page background.
 *
 *   segment    pill row. trigger sits on bg-elev with a soft rounded
 *              container; active state lifts to bg-subtle with a 2px
 *              accent ring. For dialogs/cards where the underline rail
 *              would clash with the surface edge.
 *
 * Compound API:
 *
 *   <Tabs defaultValue="overview" variant="underline">
 *     <Tabs.List aria-label="Project sections">
 *       <Tabs.Trigger value="overview">Overview</Tabs.Trigger>
 *       <Tabs.Trigger value="stats">Stats</Tabs.Trigger>
 *     </Tabs.List>
 *     <Tabs.Content value="overview">…</Tabs.Content>
 *     <Tabs.Content value="stats">…</Tabs.Content>
 *   </Tabs>
 */
import * as TabsPrimitive from "@radix-ui/react-tabs";
import {
  createContext,
  forwardRef,
  useContext,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";

type TabsVariant = "underline" | "segment";

const TabsVariantContext = createContext<TabsVariant>("underline");

interface TabsRootProps extends ComponentPropsWithoutRef<typeof TabsPrimitive.Root> {
  variant?: TabsVariant;
  children: ReactNode;
}

function TabsRoot({ variant = "underline", className, children, ...rest }: TabsRootProps) {
  return (
    <TabsVariantContext.Provider value={variant}>
      <TabsPrimitive.Root className={cn("flex flex-col", className)} {...rest}>
        {children}
      </TabsPrimitive.Root>
    </TabsVariantContext.Provider>
  );
}

interface TabsListProps extends ComponentPropsWithoutRef<typeof TabsPrimitive.List> {}

const TabsList = forwardRef<HTMLDivElement, TabsListProps>(function TabsList(
  { className, ...rest },
  ref,
) {
  const variant = useContext(TabsVariantContext);
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        variant === "underline" &&
          "flex items-center gap-1 border-b border-[var(--border-subtle)]",
        variant === "segment" &&
          "inline-flex items-center gap-1 rounded-[var(--radius-3)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] p-1",
        className,
      )}
      {...rest}
    />
  );
});

interface TabsTriggerProps extends ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> {}

const TabsTrigger = forwardRef<HTMLButtonElement, TabsTriggerProps>(function TabsTrigger(
  { className, children, ...rest },
  ref,
) {
  const variant = useContext(TabsVariantContext);
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        "relative inline-flex items-center gap-1.5",
        "text-[12.5px] tracking-tight font-medium",
        "transition-[color,background-color,box-shadow] duration-[180ms] ease-out",
        "focus-visible:outline-none",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        variant === "underline" && [
          "h-9 px-3",
          "text-[color:var(--text-tertiary)]",
          "hover:text-[color:var(--text-primary)]",
          "data-[state=active]:text-[color:var(--text-primary)]",
          "focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]",
          "rounded-t-[var(--radius-sm)]",
        ],
        variant === "segment" && [
          "h-7 px-3 rounded-[var(--radius-sm)]",
          "text-[color:var(--text-tertiary)]",
          "hover:text-[color:var(--text-primary)]",
          "data-[state=active]:bg-[var(--bg-subtle)]",
          "data-[state=active]:text-[color:var(--text-primary)]",
          "data-[state=active]:shadow-[inset_0_0_0_1px_var(--border-strong)]",
          "focus-visible:shadow-[0_0_0_2px_var(--accent)]",
        ],
        className,
      )}
      {...rest}
    >
      {children}
      {variant === "underline" && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-2 -bottom-px h-[2px] rounded-full",
            "bg-[var(--accent)] opacity-0 transition-opacity duration-[180ms] ease-out",
            "[[data-state=active]_&]:opacity-100",
          )}
        />
      )}
    </TabsPrimitive.Trigger>
  );
});

interface TabsContentProps extends ComponentPropsWithoutRef<typeof TabsPrimitive.Content> {}

const TabsContent = forwardRef<HTMLDivElement, TabsContentProps>(function TabsContent(
  { className, ...rest },
  ref,
) {
  return (
    <TabsPrimitive.Content
      ref={ref}
      className={cn("focus-visible:outline-none", className)}
      {...rest}
    />
  );
});

interface TabsExports {
  List: typeof TabsList;
  Trigger: typeof TabsTrigger;
  Content: typeof TabsContent;
}

export const Tabs: typeof TabsRoot & TabsExports = Object.assign(TabsRoot, {
  List: TabsList,
  Trigger: TabsTrigger,
  Content: TabsContent,
});
