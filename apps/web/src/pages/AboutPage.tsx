// Armin Mehri — mehri.armin@gmail.com
import { ExternalLink, Heart, Mail } from "lucide-react";
import { Card } from "@/components/ui/Card";

/**
 * Plain About page. No fetches, no dynamic content — a single static
 * surface the user reaches from the global nav. The page deliberately
 * stays small: a tagline, two paragraphs, and a Made-By block so the
 * project's authorship is one click away.
 */
export function AboutPage() {
  return (
    <div className="mx-auto max-w-[720px] px-4 py-10 grid gap-6">
      <header className="grid gap-1.5">
        <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-[color:var(--text-tertiary)]">
          About
        </span>
        <h1 className="font-editorial text-[40px] leading-[0.95] text-[color:var(--text-primary)]">
          About Carve
        </h1>
        <p className="text-[14px] text-[color:var(--text-secondary)] max-w-[60ch]">
          A computer-vision annotation platform for solo researchers and
          small teams.
        </p>
      </header>

      <Card variant="surface" radius="lg" className="p-6 grid gap-4">
        <p className="text-[14px] leading-relaxed text-[color:var(--text-primary)]">
          Carve is a self-hosted image and video annotation app with first-
          class SAM 2.1 / SAM 3 / SAM 3.1 segmentation and YOLO11 / YOLO26
          auto-annotate built in. It exports clean COCO and YOLO datasets
          and stays lightweight enough to run next to your training
          pipeline instead of behind another login.
        </p>
        <p className="text-[14px] leading-relaxed text-[color:var(--text-secondary)]">
          It is for researchers, ML practitioners, and small teams who
          want to own their data and annotate without paying per seat.
          One repo, one binary, your storage — no annotation tax.
        </p>
      </Card>

      <Card variant="surface" radius="md" className="p-5 grid gap-3">
        <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-[color:var(--text-tertiary)]">
          Made by
        </span>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[15px] font-medium text-[color:var(--text-primary)]">
            Armin Mehri
          </span>
          <a
            href="mailto:mehri.armin@gmail.com"
            className="inline-flex items-center gap-1.5 text-[13px] text-[color:var(--accent)] hover:underline"
            data-testid="about-email-link"
          >
            <Mail className="h-3.5 w-3.5" />
            mehri.armin@gmail.com
          </a>
          <a
            href="https://github.com/Rm1n90/Carve"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[13px] text-[color:var(--accent)] hover:underline"
            data-testid="about-github-link"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            github.com/Rm1n90/Carve
          </a>
          <a
            href="https://github.com/sponsors/Rm1n90"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[13px] text-[color:var(--accent)] hover:underline"
            data-testid="about-sponsor-link"
          >
            <Heart className="h-3.5 w-3.5" />
            Sponsor on GitHub
          </a>
        </div>
      </Card>

      <footer className="pt-2 text-[11.5px] text-[color:var(--text-tertiary)] tracking-tight">
        AGPL-3.0 · © 2025–2026 Armin Mehri
      </footer>
    </div>
  );
}
