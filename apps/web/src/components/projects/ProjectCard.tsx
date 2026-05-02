import { Link } from "@tanstack/react-router";
import { Star, Trash2 } from "lucide-react";
import type { Project } from "@/api/projects";
import { cn } from "@/lib/cn";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { formatRelative } from "@/lib/relativeTime";

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
interface ProjectCardProps {
  project: Project;
  pinned: boolean;
  onTogglePin: () => void;
  onDelete: () => void;
  view?: "cards" | "compact";
}

export function ProjectCard({
  project,
  pinned,
  onTogglePin,
  onDelete,
  view = "cards",
}: ProjectCardProps) {
  const confirm = useConfirm();
  const compact = view === "compact";

  return (
    <article
      data-testid={`projects-row-${project.id}`}
      data-pinned={pinned ? "true" : undefined}
      className={cn(
        "group flex items-center gap-2",
        "border-b border-[var(--border-subtle)]",
        "hover:bg-[var(--bg-hover)] transition-colors",
      )}
    >
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
          "shrink-0 ml-2 grid h-7 w-7 place-items-center rounded-[var(--radius-sm)]",
          "transition-colors",
          pinned
            ? "text-[color:var(--accent)]"
            : "text-[color:var(--text-tertiary)] opacity-60 hover:opacity-100",
          "hover:bg-[var(--bg-subtle)]",
        )}
      >
        <Star
          className="h-3.5 w-3.5"
          fill={pinned ? "currentColor" : "none"}
        />
      </button>

      <Link
        to="/projects/$projectId"
        params={{ projectId: project.id }}
        aria-label={`Open project ${project.name}`}
        className={cn(
          "flex-1 min-w-0 grid gap-0.5 px-2",
          compact ? "py-2" : "py-3",
          "focus-visible:outline-2 focus-visible:outline-[var(--accent)]",
        )}
      >
        <h3 className="text-[14px] font-medium tracking-tight text-[color:var(--text-primary)] truncate">
          {project.name}
        </h3>
        {!compact &&
          (project.description ? (
            <p className="text-[12.5px] text-[color:var(--text-tertiary)] truncate">
              {project.description}
            </p>
          ) : (
            <p className="text-[12.5px] text-[color:var(--text-tertiary)] italic">
              No description.
            </p>
          ))}
        <div
          data-testid="project-card-meta"
          className="text-[11px] text-[color:var(--text-tertiary)] mt-1 truncate"
        >
          Created {formatRelative(project.created_at)} ·{" "}
          {project.owner_email ?? "Unknown"}
        </div>
      </Link>

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
          "shrink-0 mr-3 inline-flex h-7 items-center gap-1 px-2",
          "rounded-[var(--radius-sm)] text-[color:var(--text-tertiary)] text-[11px]",
          "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity",
          "hover:bg-[var(--danger-bg)] hover:text-[color:var(--danger)]",
        )}
        aria-label={`Delete project ${project.name}`}
      >
        <Trash2 className="h-3.5 w-3.5" />
        Delete
      </button>
    </article>
  );
}
