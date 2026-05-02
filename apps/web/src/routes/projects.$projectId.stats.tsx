// Armin Mehri — mehri.armin@gmail.com
import { lazy, Suspense } from "react";
import { createRoute, Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { rootRoute } from "./_root";
import { RequireAuth } from "@/auth/RequireAuth";
import { Skeleton } from "@/components/ui/Skeleton";
import { projectsApi } from "@/api/projects";

// Lazy-load StatsPanel so the recharts chunk is fetched only on the
// stats route. Keeps the initial bundle under the 250 kB budget.
const StatsPanel = lazy(() =>
  import("@/pages/StatsPanel").then((m) => ({ default: m.StatsPanel })),
);

function ProjectStatsRoute() {
  const { projectId } = useParams({ from: "/projects/$projectId/stats" });
  const projectQ = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId),
  });
  return (
    <RequireAuth>
      <div className="mx-auto grid max-w-[1100px] gap-5 pt-2">
        {/* Back link sits above the editorial header so the user has an
            obvious return-path after clicking "View stats" on the
            project detail page. The styling mirrors the project detail
            breadcrumb tone (muted secondary, 12.5px tracking-tight) and
            uses the lucide ChevronLeft glyph already in the app. */}
        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          data-testid="stats-back-link"
          className="inline-flex items-center gap-1 text-[12.5px] tracking-tight text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)] transition-colors w-fit"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
          Back to project
        </Link>
        <header className="grid gap-1">
          <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-[color:var(--text-tertiary)]">
            Stats
          </span>
          <h1
            data-testid="stats-page-title"
            className="font-editorial text-[40px] leading-[1.05] tracking-tight text-[color:var(--text-primary)]"
          >
            {projectQ.data?.name ?? "…"}
          </h1>
        </header>
        <Suspense fallback={<Skeleton label="Loading stats…" />}>
          <StatsPanel projectId={projectId} />
        </Suspense>
      </div>
    </RequireAuth>
  );
}

export const projectStatsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/stats",
  component: ProjectStatsRoute,
});
