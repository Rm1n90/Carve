import { createRoute, useParams } from "@tanstack/react-router";
import { rootRoute } from "./_root";
import { RequireAuth } from "@/auth/RequireAuth";
import { AnnotateAssetPage } from "@/pages/AnnotateAssetPage";

function AnnotateRoute() {
  const { projectId, taskId, assetId } = useParams({
    from: "/projects/$projectId/tasks/$taskId/assets/$assetId",
  });
  return (
    <RequireAuth>
      <AnnotateAssetPage projectId={projectId} taskId={taskId} assetId={assetId} />
    </RequireAuth>
  );
}

export const annotateAssetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/tasks/$taskId/assets/$assetId",
  component: AnnotateRoute,
});
