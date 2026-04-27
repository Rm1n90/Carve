import { Link } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import type { Project } from "@/api/projects";
import { cn } from "@/lib/cn";

interface ProjectCardProps {
  project: Project;
  onDelete: () => void;
}

/**
 * Flat row used in the projects table-style listing. Click row → navigate.
 * Hover surfaces a Delete control on the right.
 */
export function ProjectCard({ project, onDelete }: ProjectCardProps) {
  return (
    <article
      className={cn(
        "group relative grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3",
        "border-b border-[var(--border-subtle)]",
        "hover:bg-[var(--bg-hover)] transition-colors",
      )}
    >
      <Link
        to="/projects/$projectId"
        params={{ projectId: project.id }}
        className="absolute inset-0 z-0 focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        aria-label={`Open project ${project.name}`}
      />
      <div className="relative z-10 grid gap-0.5 min-w-0">
        <h3 className="text-[14px] font-medium tracking-tight text-[color:var(--text-primary)] truncate">
          {project.name}
        </h3>
        {project.description ? (
          <p className="text-[12.5px] text-[color:var(--text-tertiary)] truncate">{project.description}</p>
        ) : (
          <p className="text-[12.5px] text-[color:var(--text-tertiary)] italic">No description.</p>
        )}
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (confirm(`Delete project "${project.name}"?`)) onDelete();
        }}
        className={cn(
          "relative z-20 inline-flex h-7 items-center gap-1 px-2",
          "rounded-[var(--radius-sm)] text-[color:var(--text-tertiary)] text-[11px]",
          "opacity-0 group-hover:opacity-100 transition-opacity",
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
