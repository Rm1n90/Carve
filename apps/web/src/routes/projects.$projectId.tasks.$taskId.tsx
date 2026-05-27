import { lazy, Suspense, useState } from "react";
import { createRoute, Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  Upload,
  FileArchive,
  Download,
  Images,
  BarChart3,
} from "lucide-react";
import { rootRoute } from "./_root";
import { RequireAuth } from "@/auth/RequireAuth";
import { AssetUploadDialog } from "@/pages/AssetUploadDialog";
import { ImportDialog } from "@/pages/ImportDialog";
import { ExportDialog } from "@/pages/ExportDialog";
import { AssetGrid } from "@/pages/AssetGrid";
// Lazy: keeps the recharts chunk out of the initial bundle.
const StatsPanel = lazy(() =>
  import("@/pages/StatsPanel").then((m) => ({ default: m.StatsPanel })),
);
import { projectsApi } from "@/api/projects";
import { tasksApi } from "@/api/tasks";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Tabs } from "@/components/ui/Tabs";
import { cn } from "@/lib/cn";

type Tab = "assets" | "stats";

interface ToolbarActionProps {
  icon: React.ReactNode;
  label: string;
  hint: string;
  variant?: "primary" | "default";
  testId?: string;
}

// DESIGN.md: pill button (rounded-full) with subtle scale hover, accent ring
// on focus, no all-caps. The action opens a modal instead of stacking inline.
function ToolbarAction({ icon, label, hint, variant = "default", testId }: ToolbarActionProps) {
  return (
    <DialogTrigger asChild>
      <button
        type="button"
        data-testid={testId}
        className={cn(
          "group inline-flex items-center gap-2.5 h-10 pl-4 pr-5",
          "rounded-full border transition-all duration-200",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
          "hover:scale-[1.03] active:scale-[0.99]",
          variant === "primary"
            ? [
                "bg-[var(--accent)] text-[color:var(--accent-fg)] border-[var(--accent)]",
                "hover:bg-[var(--accent-hover)] hover:border-[var(--accent-hover)]",
                "shadow-[0_2px_8px_rgba(0,0,0,0.16)]",
              ]
            : [
                "bg-transparent text-[color:var(--text-primary)] border-[var(--border-subtle)]",
                "hover:bg-[var(--bg-hover)] hover:border-[var(--border-strong)]",
              ],
        )}
        title={hint}
      >
        <span className="inline-flex h-4 w-4 items-center justify-center">{icon}</span>
        <span className="text-[13px] font-medium tracking-tight">{label}</span>
      </button>
    </DialogTrigger>
  );
}

function TaskDetail() {
  const { projectId, taskId } = useParams({ from: "/projects/$projectId/tasks/$taskId" });
  const [tab, setTab] = useState<Tab>("assets");
  const [openDialog, setOpenDialog] = useState<"upload" | "import" | "export" | null>(null);

  const projectQ = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId),
  });
  const tasksQ = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => tasksApi.listForProject(projectId),
  });
  const task = tasksQ.data?.find((t) => t.id === taskId);

  return (
    <RequireAuth>
      <div className="mx-auto grid max-w-[1200px] gap-10 pb-16">
        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          data-testid="task-detail-back-link"
          className={cn(
            "inline-flex items-center gap-1 w-fit",
            "text-[12.5px] tracking-tight text-[color:var(--text-tertiary)]",
            "hover:text-[color:var(--text-primary)] transition-colors",
          )}
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
          Back to project
        </Link>

        {/* Header — DESIGN.md weight-300 display headline, gallery whitespace,
            actions sit on the same row at desktop. */}
        <header className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div className="grid gap-2">
            <span className="font-mono-data text-[10px] tracking-[0.18em] uppercase text-tertiary">
              Task
            </span>
            <h1 className="text-[34px] md:text-[40px] font-light tracking-tight text-primary leading-[1.05]">
              <span className="text-[color:var(--text-tertiary)]">
                {projectQ.data?.name ?? "…"}
              </span>
              <span className="text-[color:var(--text-tertiary)] mx-3 font-light">/</span>
              <span className="font-normal">{task?.name ?? "…"}</span>
            </h1>
            {task && (
              <p className="text-[color:var(--text-secondary)] text-[13px]">
                {task.kind} task
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <Dialog
              open={openDialog === "upload"}
              onOpenChange={(o) => setOpenDialog(o ? "upload" : null)}
            >
              <ToolbarAction
                icon={<Upload className="h-4 w-4" />}
                label="Upload"
                hint="Upload images, videos, or .zip"
                variant="primary"
                testId="task-action-upload"
              />
              <DialogContent className="w-[min(92vw,560px)]">
                <DialogHeader>
                  <DialogTitle>Upload assets</DialogTitle>
                </DialogHeader>
                <AssetUploadDialog
                  projectId={projectId}
                  taskId={taskId}
                  mixedMode={task?.kind === "image"}
                />
              </DialogContent>
            </Dialog>

            <Dialog
              open={openDialog === "import"}
              onOpenChange={(o) => setOpenDialog(o ? "import" : null)}
            >
              <ToolbarAction
                icon={<FileArchive className="h-4 w-4" />}
                label="Import"
                hint="Import YOLO or COCO annotations"
                testId="task-action-import"
              />
              <DialogContent className="w-[min(92vw,560px)]">
                <DialogHeader>
                  <DialogTitle>Import annotations</DialogTitle>
                </DialogHeader>
                <ImportDialog taskId={taskId} />
              </DialogContent>
            </Dialog>

            <Dialog
              open={openDialog === "export"}
              onOpenChange={(o) => setOpenDialog(o ? "export" : null)}
            >
              <ToolbarAction
                icon={<Download className="h-4 w-4" />}
                label="Export"
                hint="Export annotations to YOLO or COCO"
                testId="task-action-export"
              />
              <DialogContent className="w-[min(92vw,640px)]">
                <DialogHeader>
                  <DialogTitle>Export annotations</DialogTitle>
                </DialogHeader>
                <ExportDialog projectId={projectId} taskId={taskId} />
              </DialogContent>
            </Dialog>
          </div>
        </header>

        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as Tab)}
          variant="underline"
        >
          <Tabs.List aria-label="Task sections">
            <Tabs.Trigger value="assets" data-testid="task-tab-assets">
              <Images className="h-4 w-4" /> Assets
            </Tabs.Trigger>
            <Tabs.Trigger value="stats" data-testid="task-tab-stats">
              <BarChart3 className="h-4 w-4" /> Stats
            </Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="assets">
            <AssetGrid projectId={projectId} taskId={taskId} />
          </Tabs.Content>
          <Tabs.Content value="stats">
            <Suspense fallback={null}>
              <StatsPanel taskId={taskId} />
            </Suspense>
          </Tabs.Content>
        </Tabs>
      </div>
    </RequireAuth>
  );
}

export const taskDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/tasks/$taskId",
  component: TaskDetail,
});
