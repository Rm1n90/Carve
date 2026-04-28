import { cn } from "@/lib/cn";

/**
 * Carve wordmark — editorial Instrument Serif italic "Carve" with a
 * cyan accent dot. Used in TopBar.
 *
 * v2.8 Wave 3 — replaces the prior solid-tile + Geist "Carve" treatment.
 * The serif italic is the editorial signature of the v2.8 visual system,
 * paired with the cyan dot that signals "Carve is online" without
 * needing a logo asset.
 */
export function CarveMark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-baseline gap-1.5", className)}>
      <span
        className={cn(
          "font-editorial text-[22px] leading-none",
          "text-[color:var(--text-primary)]",
        )}
      >
        Carve
      </span>
      <span
        aria-hidden
        className={cn(
          "h-1.5 w-1.5 self-center rounded-full bg-[var(--accent)]",
          "shadow-[0_0_8px_oklch(0.78_0.14_220_/_0.55)]",
        )}
      />
    </span>
  );
}
