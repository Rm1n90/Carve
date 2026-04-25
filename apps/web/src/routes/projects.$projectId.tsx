import { createRoute, useParams } from "@tanstack/react-router";
import { rootRoute } from "./_root";
import { RequireAuth } from "@/auth/RequireAuth";
import { ProjectDetailPage } from "@/pages/ProjectDetailPage";

function Detail() {
  const { projectId } = useParams({ from: "/projects/$projectId" });
  return (
    <RequireAuth>
      <ProjectDetailPage projectId={projectId} />
    </RequireAuth>
  );
}

export const projectDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
  component: Detail,
});
