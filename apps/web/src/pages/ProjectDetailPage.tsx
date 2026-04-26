import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { projectsApi } from "@/api/projects";
import { tasksApi } from "@/api/tasks";
import { statsApi, type ProjectStats } from "@/api/stats";
import { ClassesEditor } from "./ClassesEditor";
import { NewTaskDialog } from "./NewTaskDialog";

const TILE_STYLE: React.CSSProperties = {
  flex: "1 1 0",
  minWidth: 120,
  padding: "12px 16px",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8,
  background: "rgba(255,255,255,0.02)",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const TILE_NUMBER: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 600,
  lineHeight: 1.1,
};

const TILE_LABEL: React.CSSProperties = {
  fontSize: 12,
  opacity: 0.6,
  textTransform: "uppercase",
  letterSpacing: 0.5,
};

const CHIP_STYLE: React.CSSProperties = {
  padding: "4px 10px",
  borderRadius: 999,
  border: "1px solid rgba(255,255,255,0.15)",
  fontSize: 12,
  whiteSpace: "nowrap",
};

const TASK_BAR_TRACK: React.CSSProperties = {
  position: "relative",
  height: 8,
  borderRadius: 4,
  background: "rgba(255,255,255,0.08)",
  overflow: "hidden",
};

function ProjectStatsStrip({ stats }: { stats: ProjectStats }) {
  const { totals, by_class, tasks } = stats;
  const hasAny =
    totals.annotations > 0 ||
    totals.assets > 0 ||
    totals.tasks > 0 ||
    by_class.length > 0 ||
    tasks.length > 0;

  if (!hasAny) {
    return (
      <section
        style={{
          padding: 16,
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 8,
          opacity: 0.7,
        }}
      >
        No data yet.
      </section>
    );
  }

  return (
    <section style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div style={TILE_STYLE} data-testid="project-stats-totals-annotations">
          <span style={TILE_NUMBER}>{totals.annotations}</span>
          <span style={TILE_LABEL}>Annotations</span>
        </div>
        <div style={TILE_STYLE} data-testid="project-stats-totals-assets">
          <span style={TILE_NUMBER}>{totals.assets}</span>
          <span style={TILE_LABEL}>Assets</span>
        </div>
        <div style={TILE_STYLE} data-testid="project-stats-totals-tasks">
          <span style={TILE_NUMBER}>{totals.tasks}</span>
          <span style={TILE_LABEL}>Tasks</span>
        </div>
      </div>

      {by_class.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            alignItems: "center",
          }}
          data-testid="project-stats-by-class"
        >
          <span style={{ fontSize: 12, opacity: 0.6, marginRight: 4 }}>
            Top classes
          </span>
          {by_class.map((c) => (
            <span key={c.class_id} style={CHIP_STYLE}>
              {c.name} ({c.count})
            </span>
          ))}
        </div>
      )}

      {tasks.length > 0 && (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "grid",
            gap: 6,
          }}
        >
          {tasks.map((t) => {
            const widthPct = `${Math.round(
              Math.min(Math.max(t.progress_pct, 0), 1) * 100,
            )}%`;
            return (
              <li
                key={t.task_id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 80px",
                  alignItems: "center",
                  gap: 12,
                  fontSize: 13,
                }}
              >
                <div
                  style={{ display: "flex", alignItems: "center", gap: 8 }}
                >
                  <span style={{ minWidth: 80 }}>{t.name}</span>
                  <div style={{ ...TASK_BAR_TRACK, flex: 1 }}>
                    <div
                      data-testid={`project-stats-task-bar-${t.task_id}`}
                      style={{
                        position: "absolute",
                        inset: 0,
                        width: widthPct,
                        background: "rgba(120,200,255,0.55)",
                      }}
                    />
                  </div>
                </div>
                <span style={{ opacity: 0.7, textAlign: "right" }}>
                  {widthPct}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function ProjectDetailPage({ projectId }: { projectId: string }) {
  const projectQ = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId),
  });
  const tasksQ = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => tasksApi.listForProject(projectId),
  });
  const statsQ = useQuery({
    queryKey: ["project-stats", projectId],
    queryFn: () => statsApi.projectStats(projectId),
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

      {statsQ.isLoading && <p style={{ opacity: 0.7 }}>Loading stats…</p>}
      {statsQ.data && <ProjectStatsStrip stats={statsQ.data} />}
      {statsQ.error && !statsQ.isLoading && (
        <section style={{ opacity: 0.7 }}>No data yet.</section>
      )}

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
                <Link
                  to="/projects/$projectId/tasks/$taskId"
                  params={{ projectId, taskId: t.id }}
                  style={{ textDecoration: "none", color: "inherit", flex: 1, display: "flex", justifyContent: "space-between" }}
                >
                  <span>{t.name}</span>
                  <span style={{ opacity: 0.6, fontSize: 12 }}>{t.kind}</span>
                </Link>
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
