import { createRoute, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { rootRoute } from "./_root";
import { RequireAuth } from "@/auth/RequireAuth";
import { AssetUploadDialog } from "@/pages/AssetUploadDialog";
import { ImportDialog } from "@/pages/ImportDialog";
import { ExportDialog } from "@/pages/ExportDialog";
import { AssetGrid } from "@/pages/AssetGrid";
import { StatsPanel } from "@/pages/StatsPanel";
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
      <div className="mx-auto grid max-w-[1200px] gap-8">
        <header className="grid gap-1">
          <span className="font-mono-data text-[10px] tracking-[0.18em] uppercase text-tertiary">
            Task
          </span>
          <h1 className="text-[28px] font-medium tracking-tight text-primary leading-tight">
            <span className="text-secondary">{projectQ.data?.name ?? "…"}</span>
            <span className="text-tertiary mx-2">/</span>
            {task?.name ?? "…"}
          </h1>
          {task && (
            <p className="text-tertiary text-[13px]">{task.kind} task</p>
          )}
        </header>
        <AssetUploadDialog projectId={projectId} taskId={taskId} />
        <ImportDialog taskId={taskId} />
        <ExportDialog projectId={projectId} taskId={taskId} />
        <AssetGrid projectId={projectId} taskId={taskId} />
        <StatsPanel taskId={taskId} />
      </div>
    </RequireAuth>
  );
}

export const taskDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/tasks/$taskId",
  component: TaskDetail,
});
