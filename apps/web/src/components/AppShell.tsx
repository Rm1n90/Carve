// Armin Mehri — mehri.armin@gmail.com
import { type ReactNode } from "react";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { TopBar } from "@/components/nav/TopBar";
import { LeftNav } from "@/components/nav/LeftNav";
import { Toaster } from "@/components/ui/Toaster";
import { projectsApi } from "@/api/projects";

/**
 * Productivity-tool shell — TopBar (48px) + LeftNav (220px) + main content area.
 * Editor pages opt out of the LeftNav via the `EditorShell` variant below.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const projectMatch = /^\/projects\/([^/]+)/.exec(path);
  const projectId = projectMatch?.[1];

  const projectQ = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => (projectId ? projectsApi.get(projectId) : Promise.resolve(null)),
    enabled: !!projectId,
    staleTime: 30_000,
  });

  // Build breadcrumb crumbs from the current path.
  const crumbs: { label: string; to?: string }[] = [];
  if (path.startsWith("/projects")) {
    crumbs.push({ label: "Projects", to: "/projects" });
    if (projectQ.data) {
      crumbs.push({
        label: projectQ.data.name,
        to: `/projects/${projectQ.data.id}`,
      });
    }
  }

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex h-screen flex-col bg-[var(--bg-app)] text-[color:var(--text-primary)]">
        <Toaster />
        <TopBar crumbs={crumbs.length > 0 ? crumbs : undefined} />
        <div className="flex flex-1 min-h-0">
          <LeftNav />
          <main className="flex-1 min-w-0 overflow-y-auto bg-[var(--bg-app)]">
            <div className="px-6 py-6">{children}</div>
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}

/**
 * Edge-to-edge variant for the annotation editor — no padding, no scroll.
 * The editor manages its own layout grid.
 */
export function AppShellBleed({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-screen flex-col overflow-hidden bg-[var(--bg-app)]">
        <Toaster />
        {children}
      </div>
    </TooltipProvider>
  );
}
