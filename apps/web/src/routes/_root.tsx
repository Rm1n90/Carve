import { Outlet, createRootRoute, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { useAuth } from "@/auth/store";
import { bootstrapStatus } from "@/auth/api";
import { FirstRunWizard } from "@/pages/FirstRunWizard";

function RootComponent() {
  const token = useAuth((s) => s.accessToken);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const onAuthPage = path === "/login" || path === "/register";

  const bs = useQuery({
    queryKey: ["auth", "bootstrap-status"],
    queryFn: bootstrapStatus,
    staleTime: Infinity,
    retry: false,
  });

  if (bs.isLoading) {
    return <p className="p-6 text-tertiary text-[13px]">Loading…</p>;
  }
  if (bs.data && !bs.data.users_exist) {
    return <FirstRunWizard onSuccess={() => bs.refetch()} />;
  }

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
