import { lazy, Suspense } from "react";
import { createRoute, useParams } from "@tanstack/react-router";
import { rootRoute } from "./_root";
import { RequireAuth } from "@/auth/RequireAuth";
import { Skeleton } from "@/components/ui/Skeleton";

// Lazy-load the annotate page so the Pixi-heavy AnnotationCanvas chunk
// (and its transitive @pixi/* deps) is fetched only when the user opens
// an asset, keeping the initial bundle below the 250 kB budget.
const AnnotateAssetPage = lazy(() =>
  import("@/pages/AnnotateAssetPage").then((m) => ({
    default: m.AnnotateAssetPage,
  })),
);

function AnnotateRoute() {
  const { projectId, taskId, assetId } = useParams({
    from: "/projects/$projectId/tasks/$taskId/assets/$assetId",
  });
  return (
    <RequireAuth>
      <Suspense fallback={<Skeleton label="Loading editor…" />}>
        <AnnotateAssetPage
          projectId={projectId}
          taskId={taskId}
          assetId={assetId}
        />
      </Suspense>
    </RequireAuth>
  );
}

export const annotateAssetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/tasks/$taskId/assets/$assetId",
  component: AnnotateRoute,
});
