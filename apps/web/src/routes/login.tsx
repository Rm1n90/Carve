import { Link, createRoute, useNavigate } from "@tanstack/react-router";
import { rootRoute } from "./_root";
import { LoginPage } from "@/auth/LoginPage";

function LoginRoute() {
  const nav = useNavigate();
  return (
    <div>
      <LoginPage onSuccess={() => nav({ to: "/" })} />
      <p style={{ textAlign: "center" }}>
        No account? <Link to="/register">Create one</Link>
      </p>
    </div>
  );
}

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginRoute,
});
