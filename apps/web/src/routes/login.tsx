// Armin Mehri — mehri.armin@gmail.com
import { createRoute, useNavigate } from "@tanstack/react-router";
import { rootRoute } from "./_root";
import { LoginPage } from "@/auth/LoginPage";

function LoginRoute() {
  const nav = useNavigate();
  return <LoginPage onSuccess={() => nav({ to: "/" })} />;
}

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginRoute,
});
