import { useQuery } from "@tanstack/react-query";
import { projectsApi } from "@/api/projects";
import { tasksApi } from "@/api/tasks";
import { ClassesEditor } from "./ClassesEditor";
import { NewTaskDialog } from "./NewTaskDialog";

export function ProjectDetailPage({ projectId }: { projectId: string }) {
  const projectQ = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId),
  });
  const tasksQ = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => tasksApi.listForProject(projectId),
  });

  if (projectQ.isLoading) return <p>Loading…</p>;
  if (projectQ.error || !projectQ.data) return <p>Project not found.</p>;
  const project = projectQ.data;

  return (
    <div style={{ display: "grid", gap: 24, maxWidth: 1100, margin: "0 auto" }}>
      <header>
        <h1 style={{ margin: 0 }}>{project.name}</h1>
        {project.description && <p style={{ opacity: 0.7 }}>{project.description}</p>}
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 24 }}>
        <section style={{ display: "grid", gap: 12 }}>
          <h2 style={{ margin: 0 }}>Tasks</h2>
          <NewTaskDialog projectId={projectId} onCreated={() => {}} />
          {tasksQ.isLoading && <p>Loading tasks…</p>}
          <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 6 }}>
            {tasksQ.data?.map((t) => (
              <li
                key={t.id}
                style={{
                  padding: 12,
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 8,
                  display: "flex",
                  justifyContent: "space-between",
                }}
              >
                <span>{t.name}</span>
                <span style={{ opacity: 0.6, fontSize: 12 }}>{t.kind}</span>
              </li>
            ))}
            {(tasksQ.data?.length ?? 0) === 0 && !tasksQ.isLoading && (
              <li style={{ opacity: 0.6, fontSize: 13 }}>No tasks yet.</li>
            )}
          </ul>
        </section>
        <ClassesEditor projectId={projectId} />
      </div>
    </div>
  );
}
