import { Link } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import type { Project } from "@/api/projects";
import { cn } from "@/lib/cn";
import { useConfirm } from "@/components/ui/ConfirmDialog";

interface ProjectCardProps {
  project: Project;
  onDelete: () => void;
}

/**
 * Flat row used in the projects table-style listing. The whole content
 * (title + description) sits INSIDE the `<Link>` so any click on the row
 * navigates to the detail page. The Delete button is a sibling that calls
 * `e.stopPropagation()` so it doesn't also navigate.
 *
 * Audit bug 5: previously the Link was an absolute overlay (`z-0`)
 * underneath a `z-10` content div. The text inside that div ate clicks
 * meant for the link, so the row only navigated when clicking the narrow
 * gap between the name and the Delete button.
 */
export function ProjectCard({ project, onDelete }: ProjectCardProps) {
  const confirm = useConfirm();
  return (
    <article
      className={cn(
        "group flex items-center gap-2",
        "border-b border-[var(--border-subtle)]",
        "hover:bg-[var(--bg-hover)] transition-colors",
      )}
    >
      <Link
        to="/projects/$projectId"
        params={{ projectId: project.id }}
        aria-label={`Open project ${project.name}`}
        className={cn(
          "flex-1 min-w-0 grid gap-0.5 px-4 py-3",
          "focus-visible:outline-2 focus-visible:outline-[var(--accent)]",
        )}
      >
        <h3 className="text-[14px] font-medium tracking-tight text-[color:var(--text-primary)] truncate">
          {project.name}
        </h3>
        {project.description ? (
          <p className="text-[12.5px] text-[color:var(--text-tertiary)] truncate">{project.description}</p>
        ) : (
          <p className="text-[12.5px] text-[color:var(--text-tertiary)] italic">No description.</p>
        )}
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
