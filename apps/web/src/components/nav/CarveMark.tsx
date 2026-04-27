import { cn } from "@/lib/cn";

/**
 * Carve wordmark — flat indigo "C" tile + "Carve" text. Used in TopBar.
 * Replaces the previous inline SVG mark in AppShell.tsx.
 */
export function CarveMark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span
        aria-hidden
        className="grid h-6 w-6 place-items-center rounded-[var(--radius-sm)] bg-[var(--accent)] text-[color:var(--accent-fg)] text-[13px] font-semibold tracking-tight"
      >
        C
      </span>
      <span className="text-[14px] font-semibold tracking-tight text-[color:var(--text-primary)]">
        Carve
      </span>
    </span>
  );
}
