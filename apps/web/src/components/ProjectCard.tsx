import { Link } from "@tanstack/react-router";
import type { Project } from "@/api/projects";

export function ProjectCard({
  project,
  onDelete,
}: {
  project: Project;
  onDelete: () => void;
}) {
  return (
    <article
      style={{
        padding: 16,
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <h3 style={{ margin: 0 }}>
        <Link to="/projects/$projectId" params={{ projectId: project.id }}>
          {project.name}
        </Link>
      </h3>
      {project.description && (
        <p style={{ margin: 0, opacity: 0.75, fontSize: 13 }}>{project.description}</p>
      )}
      <button
        onClick={() => {
          if (confirm(`Delete project "${project.name}"?`)) onDelete();
        }}
        style={{ alignSelf: "flex-start" }}
      >
        Delete
      </button>
    </article>
  );
}
