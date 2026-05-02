// Armin Mehri — mehri.armin@gmail.com
import { createRoute, useNavigate } from "@tanstack/react-router";
import { rootRoute } from "./_root";
import { RegisterPage } from "@/auth/RegisterPage";

function RegisterRoute() {
  const nav = useNavigate();
  return <RegisterPage onSuccess={() => nav({ to: "/" })} />;
}

export const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register",
  component: RegisterRoute,
});
