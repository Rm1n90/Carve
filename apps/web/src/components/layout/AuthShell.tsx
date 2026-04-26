import { type ReactNode } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/cn";

interface AuthShellProps {
  /** Headline shown on the editorial left pane (will be wrapped in italic serif). */
  headline: ReactNode;
  /** Lead paragraph under the headline. */
  subtitle: ReactNode;
  /** Optional decorative content below subtitle (e.g. step indicator, bullet list). */
  leftMeta?: ReactNode;
  /** Right-side card title (Geist Medium). */
  cardTitle: ReactNode;
  /** Right-side card description shown under the title. */
  cardDescription?: ReactNode;
  /** Right-side card body — the form. */
  children: ReactNode;
  /** Footer slot — link to the alternate auth screen. */
  cardFooter?: ReactNode;
}

export function AuthShell({
  headline,
  subtitle,
  leftMeta,
  cardTitle,
  cardDescription,
  children,
  cardFooter,
}: AuthShellProps) {
  return (
    <div className="grid min-h-screen grid-cols-1 lg:grid-cols-2 bg-base">
      {/* ---- Left: editorial bleed ---- */}
      <aside
        className={cn(
          "gradient-mesh relative flex flex-col justify-between",
          "p-10 lg:p-14",
          "min-h-[280px] lg:min-h-screen",
          "border-b lg:border-b-0 lg:border-r border-[var(--border-subtle)]",
        )}
      >
        <div className="flex items-center gap-2.5 text-primary">
          <span className="font-mono-data text-[11px] tracking-[0.18em] text-tertiary uppercase">
            Carve · v2.0
          </span>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="grid gap-5 max-w-[520px]"
        >
          <h1 className="editorial text-[64px] sm:text-[80px] lg:text-[96px] text-primary leading-[0.92]">
            {headline}
          </h1>
          <p className="text-[16px] sm:text-[18px] text-secondary tracking-tight max-w-[460px]">
            {subtitle}
          </p>
          {leftMeta}
        </motion.div>

        <footer className="text-[11px] text-tertiary font-mono-data tracking-wide flex items-center gap-3">
          <span>Self-hosted</span>
          <span aria-hidden>·</span>
          <span>S3 + Postgres + Redis</span>
          <span aria-hidden>·</span>
          <span>SAM-Hiera ready</span>
        </footer>
      </aside>

      {/* ---- Right: glass card ---- */}
      <section className="flex items-center justify-center p-6 sm:p-10">
        <motion.div
          initial={{ opacity: 0, scale: 0.97, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
          className={cn(
            "w-full max-w-[420px]",
            "rounded-[var(--radius-xl)] border border-[var(--border-subtle)]",
            "bg-[var(--bg-glass-strong)] backdrop-blur-2xl",
            "shadow-[var(--shadow-elev-3),_0_0_60px_oklch(0.78_0.16_215_/_0.10)]",
            "p-8 sm:p-10",
          )}
        >
          <header className="mb-6 grid gap-1">
            <h2 className="text-[24px] sm:text-[28px] font-medium tracking-tight text-primary">
              {cardTitle}
            </h2>
            {cardDescription && (
              <p className="text-[13px] text-secondary">{cardDescription}</p>
            )}
          </header>
          {children}
          {cardFooter && (
            <footer className="mt-6 text-[13px] text-tertiary text-center">{cardFooter}</footer>
          )}
        </motion.div>
      </section>
    </div>
  );
}
