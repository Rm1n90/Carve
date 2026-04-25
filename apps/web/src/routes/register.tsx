import { Link, createRoute, useNavigate } from "@tanstack/react-router";
import { rootRoute } from "./_root";
import { RegisterPage } from "@/auth/RegisterPage";

function RegisterRoute() {
  const nav = useNavigate();
  return (
    <div>
      <RegisterPage onSuccess={() => nav({ to: "/" })} />
      <p style={{ textAlign: "center" }}>
        Have an account? <Link to="/login">Sign in</Link>
      </p>
    </div>
  );
}

export const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register",
  component: RegisterRoute,
});
