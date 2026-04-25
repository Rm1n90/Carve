import { createRoute, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { rootRoute } from "./_root";
import { RequireAuth } from "@/auth/RequireAuth";
import { AssetUploadDialog } from "@/pages/AssetUploadDialog";
import { AssetGrid } from "@/pages/AssetGrid";
import { projectsApi } from "@/api/projects";
import { tasksApi } from "@/api/tasks";

function TaskDetail() {
  const { projectId, taskId } = useParams({ from: "/projects/$projectId/tasks/$taskId" });
  const projectQ = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId),
  });
  const tasksQ = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => tasksApi.listForProject(projectId),
  });
  const task = tasksQ.data?.find((t) => t.id === taskId);

  return (
    <RequireAuth>
      <div style={{ display: "grid", gap: 24, maxWidth: 1100, margin: "0 auto" }}>
        <header>
          <h1 style={{ margin: 0 }}>
            {projectQ.data?.name ?? "…"} · {task?.name ?? "…"}
          </h1>
          {task && (
            <p style={{ opacity: 0.6, fontSize: 13 }}>{task.kind} task</p>
          )}
        </header>
        <AssetUploadDialog projectId={projectId} taskId={taskId} />
        <AssetGrid taskId={taskId} />
      </div>
    </RequireAuth>
  );
}

export const taskDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/tasks/$taskId",
  component: TaskDetail,
});
