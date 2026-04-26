import { Link } from "@tanstack/react-router";
import { Trash2, ArrowUpRight } from "lucide-react";
import type { Project } from "@/api/projects";
import { cn } from "@/lib/cn";

interface ProjectCardProps {
  project: Project;
  onDelete: () => void;
}

export function ProjectCard({ project, onDelete }: ProjectCardProps) {
  return (
    <article
      className={cn(
        "group relative flex flex-col gap-4",
        "rounded-[var(--radius-lg)] border border-[var(--border-subtle)]",
        "bg-[var(--bg-glass)] backdrop-blur-md",
        "p-5 sm:p-6",
        "shadow-[var(--shadow-elev-1)]",
        "transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]",
        "hover:-translate-y-0.5 hover:border-[var(--border-strong)]",
        "hover:shadow-[var(--shadow-elev-2),_0_0_28px_oklch(0.78_0.16_215_/_0.10)]",
      )}
    >
      <Link
        to="/projects/$projectId"
        params={{ projectId: project.id }}
        className="absolute inset-0 z-0 rounded-[var(--radius-lg)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        aria-label={`Open project ${project.name}`}
      />
      <header className="relative z-10 flex items-start justify-between gap-3">
        <h3 className="text-[20px] font-medium tracking-tight text-primary leading-tight line-clamp-2">
          {project.name}
        </h3>
        <ArrowUpRight
          className="h-4 w-4 text-tertiary opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all"
          aria-hidden
        />
      </header>
      {project.description ? (
        <p className="relative z-10 text-[13px] text-secondary leading-relaxed line-clamp-2">
          {project.description}
        </p>
      ) : (
        <p className="relative z-10 text-[13px] text-tertiary italic">No description.</p>
      )}
      <footer className="relative z-10 mt-auto flex items-center justify-between pt-2 border-t border-[var(--border-subtle)]">
        <div className="flex items-center gap-3 text-[11px] text-tertiary">
          <span className="font-mono-data tracking-wide uppercase">Project</span>
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
            "rounded-[var(--radius-sm)] text-tertiary text-[11px]",
            "hover:bg-[oklch(0.70_0.20_25_/_0.10)] hover:text-[var(--danger)]",
            "transition-colors",
          )}
          aria-label={`Delete project ${project.name}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </button>
      </footer>
    </article>
  );
}
