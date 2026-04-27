import { type ReactNode } from "react";
import { cn } from "@/lib/cn";

interface AuthShellProps {
  cardTitle: ReactNode;
  cardDescription?: ReactNode;
  children: ReactNode;
  cardFooter?: ReactNode;
  /** Optional row of inline icons + labels above the form (used by FirstRunWizard). */
  topInline?: ReactNode;
  /** Card max width, defaults to 420px. */
  maxWidth?: number;
}

/**
 * Auth wrapper — simple centered card on a white background. No
 * editorial bleed, no mesh gradient, no Instrument Serif. Friendly but
 * minimal.
 */
export function AuthShell({
  cardTitle,
  cardDescription,
  children,
  cardFooter,
  topInline,
  maxWidth = 420,
}: AuthShellProps) {
  return (
    <div className="grid min-h-screen place-items-center bg-[var(--bg-app)] px-4 py-10">
      <div
        className={cn(
          "w-full",
          "rounded-[var(--radius-lg)] border border-[var(--border-subtle)]",
          "bg-[var(--bg-elev)]",
          "shadow-[var(--shadow-elev-1)]",
          "p-6 sm:p-8",
        )}
        style={{ maxWidth: `${maxWidth}px` }}
      >
        <div className="mb-5 flex items-center gap-2">
          <span
            aria-hidden
            className="grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] bg-[var(--accent)] text-white text-[14px] font-semibold tracking-tight"
          >
            C
          </span>
          <span className="text-[14px] font-semibold tracking-tight text-[color:var(--text-primary)]">
            Carve
          </span>
        </div>
        <header className="mb-5 grid gap-1">
          <h2 className="text-[22px] font-medium tracking-tight text-[color:var(--text-primary)]">
            {cardTitle}
          </h2>
          {cardDescription && (
            <p className="text-[13px] text-[color:var(--text-tertiary)]">{cardDescription}</p>
          )}
        </header>
        {topInline}
        {children}
        {cardFooter && (
          <footer className="mt-5 text-[13px] text-[color:var(--text-tertiary)] text-left">
            {cardFooter}
          </footer>
        )}
      </div>
    </div>
  );
}
