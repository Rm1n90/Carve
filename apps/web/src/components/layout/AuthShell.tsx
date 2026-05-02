import { type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Logo } from "@/components/brand/Logo";

interface AuthShellProps {
  cardTitle: ReactNode;
  cardDescription?: ReactNode;
  /**
   * Optional small uppercase eyebrow rendered above the card title — e.g.
   * "Sign in" / "Register" / "Welcome". v2.9 audit P1-8.
   */
  eyebrow?: ReactNode;
  children: ReactNode;
  cardFooter?: ReactNode;
  /** Optional row of inline icons + labels above the form (used by FirstRunWizard). */
  topInline?: ReactNode;
  /** Card max width, defaults to 420px. */
  maxWidth?: number;
}

/**
 * Auth wrapper. v2.9 audit P1-8 — wraps the card in the v2.8 liquid glass
 * surface (`.glass-surface-strong .glass-specular`), uses the editorial
 * Instrument Serif italic for the title, swaps the inline tile + bold
 * Geist for the shared <CarveMark/>, and lights the page with a single
 * low-opacity cyan radial gradient behind the card.
 */
export function AuthShell({
  cardTitle,
  cardDescription,
  eyebrow,
  children,
  cardFooter,
  topInline,
  maxWidth = 420,
}: AuthShellProps) {
  return (
    <div
      className={cn(
        "relative grid min-h-screen place-items-center bg-[var(--bg-app)] px-4 py-10",
        // Single atmospheric radial — top-center, --accent at 0.04 opacity.
        // Soft and large; sits behind the card and never competes.
        "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-[60vh] before:content-['']",
        "before:bg-[radial-gradient(ellipse_at_top,oklch(0.78_0.14_220/0.04),transparent_70%)]",
      )}
    >
      <div
        className={cn(
          "relative w-full",
          "rounded-2xl",
          "glass-surface-strong glass-specular",
          "p-8",
        )}
        style={{ maxWidth: `${maxWidth}px` }}
      >
        <div className="mb-6 flex items-center justify-center">
          <Logo variant="stacked" size={48} />
        </div>
        <header className="mb-6 grid gap-2">
          {eyebrow && (
            <span
              data-testid="auth-eyebrow"
              className="font-mono text-[10px] tracking-[0.18em] uppercase text-[color:var(--text-tertiary)]"
            >
              {eyebrow}
            </span>
          )}
          <h1
            data-testid="auth-card-title"
            className="font-editorial text-[36px] leading-[1.05] tracking-tight text-[color:var(--text-primary)]"
          >
            {cardTitle}
          </h1>
          {cardDescription && (
            <p className="text-[13px] text-[color:var(--text-secondary)]">{cardDescription}</p>
          )}
        </header>
        {topInline}
        {children}
        {cardFooter && (
          <footer className="mt-6 text-[13px] text-[color:var(--text-tertiary)] text-left">
            {cardFooter}
          </footer>
        )}
      </div>
    </div>
  );
}
