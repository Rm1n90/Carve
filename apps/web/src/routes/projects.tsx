// Armin Mehri — mehri.armin@gmail.com
import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./_root";
import { RequireAuth } from "@/auth/RequireAuth";
import { ProjectsPage } from "@/pages/ProjectsPage";

export const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
  component: () => (
    <RequireAuth>
      <ProjectsPage />
    </RequireAuth>
  ),
});
