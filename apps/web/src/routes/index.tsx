import { createRoute, useNavigate } from "@tanstack/react-router";
import { rootRoute } from "./_root";
import { useAuth } from "@/auth/store";
import { logout } from "@/auth/api";
import { RequireAuth } from "@/auth/RequireAuth";

function Home() {
  const user = useAuth((s) => s.user);
  const nav = useNavigate();
  return (
    <main style={{ padding: 32 }}>
      <h1>VisualAutoAnnotator</h1>
      <p>
        Signed in as {user?.email} ({user?.role})
      </p>
      <button
        onClick={() => {
          logout();
          nav({ to: "/login" });
        }}
      >
        Sign out
      </button>
    </main>
  );
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => (
    <RequireAuth>
      <Home />
    </RequireAuth>
  ),
});
