import { Outlet, createRootRoute, useRouterState } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { useAuth } from "@/auth/store";

function RootComponent() {
  const token = useAuth((s) => s.accessToken);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const onAuthPage = path === "/login" || path === "/register";
  if (!token || onAuthPage) {
    return <Outlet />;
  }
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

export const rootRoute = createRootRoute({ component: RootComponent });
