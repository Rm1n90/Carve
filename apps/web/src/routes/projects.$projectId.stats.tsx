import { createRoute, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { rootRoute } from "./_root";
import { RequireAuth } from "@/auth/RequireAuth";
import { StatsPanel } from "@/pages/StatsPanel";
import { projectsApi } from "@/api/projects";

function ProjectStatsRoute() {
  const { projectId } = useParams({ from: "/projects/$projectId/stats" });
  const projectQ = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId),
  });
  return (
    <RequireAuth>
      <div className="mx-auto grid max-w-[1100px] gap-5">
        <header className="grid gap-0.5">
          <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-[color:var(--text-tertiary)]">
            Stats
          </span>
          <h1 className="text-[20px] font-medium tracking-tight text-[color:var(--text-primary)] leading-tight">
            {projectQ.data?.name ?? "…"}
          </h1>
        </header>
        <StatsPanel projectId={projectId} />
      </div>
    </RequireAuth>
  );
}

export const projectStatsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/stats",
  component: ProjectStatsRoute,
});
