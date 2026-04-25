import { Navigate, createRoute } from "@tanstack/react-router";
import { rootRoute } from "./_root";
import { useAuth } from "@/auth/store";

function Home() {
  const token = useAuth((s) => s.accessToken);
  return <Navigate to={token ? "/projects" : "/login"} replace />;
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Home,
});
