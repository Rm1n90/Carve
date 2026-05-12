// Armin Mehri — mehri.armin@gmail.com
import { Outlet, createRootRoute, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AppShell, AppShellBleed } from "@/components/AppShell";
import { Skeleton } from "@/components/ui/Skeleton";
import { useAuth } from "@/auth/store";
import { bootstrapStatus } from "@/auth/api";
import { FirstRunWizard } from "@/pages/FirstRunWizard";

const EDITOR_PATH_RX = /^\/projects\/[^/]+\/tasks\/[^/]+\/assets\/[^/]+$/;

function RootComponent() {
  const token = useAuth((s) => s.accessToken);
  const path = useRouterState({ select: (s) => s.location.pathname });
  // /invite/<token> uses the same full-screen AuthShell as /login and
  // /register. Treat it as an auth surface so the AppShell (sidebar +
  // topbar) doesn't wrap the centered invite card, which on logged-in
  // inviters produced a blank/broken layout.
  const onAuthPage =
    path === "/login" || path === "/register" || path.startsWith("/invite/");
  const onEditorPage = EDITOR_PATH_RX.test(path);

  const bs = useQuery({
    queryKey: ["auth", "bootstrap-status"],
    queryFn: bootstrapStatus,
    staleTime: Infinity,
    retry: false,
  });

  if (bs.isLoading) {
    // v3.24.6 — unified loading surface. Same Skeleton component
    // used by Suspense fallbacks and AnnotateAssetPage so refresh
    // never flashes three different fonts/layouts.
    return <Skeleton fullScreen />;
  }
  if (bs.data && !bs.data.users_exist) {
    return <FirstRunWizard onSuccess={() => bs.refetch()} />;
  }

  if (!token || onAuthPage) {
    return <Outlet />;
  }
  if (onEditorPage) {
    return (
      <AppShellBleed>
        <Outlet />
      </AppShellBleed>
    );
  }
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

export const rootRoute = createRootRoute({ component: RootComponent });
