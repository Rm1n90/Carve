import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { ArrowUpRight, Star, Trash2 } from "lucide-react";
import type { Project } from "@/api/projects";
import { cn } from "@/lib/cn";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { formatRelative } from "@/lib/relativeTime";

/**
 * v3.30 — deterministic accent colour per project. Hashes the id into
 * an OKLCH hue so cards feel visually distinct without storing a
 * colour on the row.
 */
function useProjectAccent(projectId: string, projectName: string) {
  return useMemo(() => {
    let h = 0;
    for (let i = 0; i < projectId.length; i++) {
      h = (h * 31 + projectId.charCodeAt(i)) >>> 0;
    }
    const hue = h % 360;
    return {
      from: `oklch(0.74 0.16 ${hue})`,
      to: `oklch(0.68 0.19 ${(hue + 40) % 360})`,
      initial: (projectName.trim().slice(0, 1) || "?").toUpperCase(),
    };
  }, [projectId, projectName]);
}

/**
 * Plan 14 Phase 8 Task 1 — projects-index row card with optional pin star.
 *
 * Two visual modes:
 *   - ``view="cards"`` (default) — generous row with name + description +
 *     meta line. Mirrors the audit-bug-5 "whole row inside Link" hit-zone
 *     fix from the original ``components/ProjectCard.tsx``.
 *   - ``view="compact"`` — dense single-line row used by the compact
 *     list view; trades description for tighter vertical rhythm.
 *
 * The pin star is a sibling of the link (so it never navigates) and uses
 * ``stopPropagation`` to keep its click contained.
 */
export interface ProjectCardStats {
  total: number;
  completed: number;
  percent: number;
  lastActivityAt: string | null;
}

interface ProjectCardProps {
  project: Project;
  pinned: boolean;
  onTogglePin: () => void;
  onDelete: () => void;
  view?: "cards" | "compact";
  /**
   * Optional task summary surfaced as a mini completion ring + an
   * "Updated N ago" meta line. Omitted / null falls back to "Created N
   * ago" without the ring — handy for huge workspaces that exceed the
   * page-level fan-out cap.
   */
  stats?: ProjectCardStats | null;
}

export function ProjectCard({
  project,
  pinned,
  onTogglePin,
  onDelete,
  view = "cards",
  stats = null,
}: ProjectCardProps) {
  const confirm = useConfirm();
  const compact = view === "compact";
  const accent = useProjectAccent(project.id, project.name);

  return (
    <article
      data-testid={`projects-row-${project.id}`}
      data-pinned={pinned ? "true" : undefined}
      className={cn(
        "group relative flex items-stretch gap-2 overflow-hidden",
        "rounded-[var(--radius-md)] border border-[var(--border-subtle)]",
        "bg-[var(--bg-elev)] hover:bg-[var(--bg-hover)]",
        "transition-[transform,box-shadow,background-color] duration-150",
        "hover:-translate-y-px hover:shadow-[0_2px_12px_rgba(0,0,0,0.10)]",
      )}
    >
      {/* Project-seeded accent strip on the leading edge — gives each
          project a unique visual signature without storing a colour. */}
      <span
        aria-hidden
        className="absolute left-0 top-0 bottom-0 w-[3px]"
        style={{
          background: `linear-gradient(180deg, ${accent.from}, ${accent.to})`,
        }}
      />

      {/* Avatar tile — first letter on a gradient background so a long
          row of cards reads as a list of distinct entities. */}
      <Link
        to="/projects/$projectId"
        params={{ projectId: project.id }}
        aria-hidden
        tabIndex={-1}
        className={cn(
          "shrink-0 self-center ml-3 grid place-items-center",
          compact ? "h-8 w-8 text-[12px]" : "h-10 w-10 text-[14px]",
          "rounded-[var(--radius-sm)]",
          "font-mono font-medium text-white tracking-tight",
        )}
        style={{
          background: `linear-gradient(135deg, ${accent.from}, ${accent.to})`,
        }}
      >
        {accent.initial}
      </Link>

      <Link
        to="/projects/$projectId"
        params={{ projectId: project.id }}
        aria-label={`Open project ${project.name}`}
        className={cn(
          "flex-1 min-w-0 grid gap-0.5 pr-2 pl-1",
          compact ? "py-2" : "py-3",
          "focus-visible:outline-2 focus-visible:outline-[var(--accent)]",
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <h3
            className={cn(
              "font-medium tracking-tight text-[color:var(--text-primary)] truncate",
              compact ? "text-[13px]" : "text-[15px]",
            )}
          >
            {project.name}
          </h3>
          {pinned && (
            <span
              aria-hidden
              className={cn(
                "shrink-0 inline-flex items-center gap-1 h-5 px-1.5",
                "rounded-full text-[10px] font-mono tracking-[0.08em] uppercase",
                "bg-[var(--accent-bg)] text-[color:var(--accent)]",
              )}
            >
              <Star className="h-2.5 w-2.5" fill="currentColor" />
              Pinned
            </span>
          )}
        </div>
        {!compact &&
          (project.description ? (
            <p className="text-[12.5px] text-[color:var(--text-secondary)] truncate">
              {project.description}
            </p>
          ) : (
            <p className="text-[12.5px] text-[color:var(--text-tertiary)] italic">
              No description.
            </p>
          ))}
        <div
          data-testid="project-card-meta"
          className="text-[11px] text-[color:var(--text-tertiary)] mt-1 truncate flex items-center gap-1.5"
        >
          <span>Created {formatRelative(project.created_at)}</span>
          {stats?.lastActivityAt && (
            <>
              <span aria-hidden>·</span>
              <span>Updated {formatRelative(stats.lastActivityAt)}</span>
            </>
          )}
          <span aria-hidden>·</span>
          <span className="truncate">{project.owner_email ?? "Unknown"}</span>
        </div>
      </Link>

      {/* Mini completion ring — only when stats are available. Same
          gradient as the avatar tile so the card reads as one unit. */}
      {stats && stats.total > 0 && !compact && (
        <MiniCompletionRing
          percent={stats.percent}
          completed={stats.completed}
          total={stats.total}
          accent={accent}
        />
      )}

      {/* Trailing action cluster — pin first (always visible state),
          delete only on hover. The open-arrow gives an affordance for
          the whole-row link without making the chrome too busy. */}
      <div className="shrink-0 self-center flex items-center gap-1 pr-2">
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onTogglePin();
          }}
          data-testid={`projects-pin-toggle-${project.id}`}
          aria-label={
            pinned
              ? `Unpin project ${project.name}`
              : `Pin project ${project.name}`
          }
          aria-pressed={pinned}
          className={cn(
            "grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] transition-colors",
            pinned
              ? "text-[color:var(--accent)]"
              : "text-[color:var(--text-tertiary)] opacity-60 hover:opacity-100",
            "hover:bg-[var(--bg-subtle)]",
          )}
        >
          <Star className="h-3.5 w-3.5" fill={pinned ? "currentColor" : "none"} />
        </button>
        <button
          type="button"
          onClick={async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const ok = await confirm({
              title: "Delete project?",
              description: (
                <>
                  Are you sure you want to delete{" "}
                  <span className="font-medium text-[color:var(--text-primary)]">
                    {project.name}
                  </span>
                  ? This moves it to Trash.
                </>
              ),
              variant: "danger",
              confirmLabel: "Delete",
            });
            if (ok) onDelete();
          }}
          className={cn(
            "inline-flex h-7 items-center gap-1 px-2 rounded-[var(--radius-sm)]",
            "text-[color:var(--text-tertiary)] text-[11px]",
            "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity",
            "hover:bg-[var(--danger-bg)] hover:text-[color:var(--danger)]",
          )}
          aria-label={`Delete project ${project.name}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <span
          aria-hidden
          className={cn(
            "ml-0.5 inline-grid h-7 w-7 place-items-center rounded-[var(--radius-sm)]",
            "text-[color:var(--text-tertiary)] opacity-0 group-hover:opacity-100 transition-opacity",
          )}
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
        </span>
      </div>
    </article>
  );
}

/**
 * v3.30 — 48-px completion ring used inline on each project card.
 * Mirrors the visual language of the project-detail hero so a user
 * scanning the index gets the same readout in miniature.
 */
function MiniCompletionRing({
  percent,
  completed,
  total,
  accent,
}: {
  percent: number;
  completed: number;
  total: number;
  accent: { from: string; to: string };
}) {
  const size = 48;
  const stroke = 4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = (percent / 100) * c;
  const gradId = `pcard-${(accent.from + accent.to).replace(/[^a-z0-9]/gi, "")}`;
  return (
    <div
      data-testid="project-card-ring"
      className="relative shrink-0 self-center grid place-items-center"
      style={{ width: size, height: size }}
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${completed} of ${total} tasks complete`}
      title={`${completed}/${total} tasks complete`}
    >
      <svg width={size} height={size} className="-rotate-90">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={accent.from} />
            <stop offset="100%" stopColor={accent.to} />
          </linearGradient>
        </defs>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--bg-subtle)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          style={{ transition: "stroke-dasharray 500ms cubic-bezier(0.16, 1, 0.3, 1)" }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center leading-none">
        <span className="font-mono text-[10.5px] tabular-nums font-medium text-[color:var(--text-primary)]">
          {percent}%
        </span>
      </div>
    </div>
  );
}
