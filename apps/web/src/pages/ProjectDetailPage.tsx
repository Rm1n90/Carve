// Armin Mehri — mehri.armin@gmail.com
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Tabs } from "@/components/ui/Tabs";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  BarChart3,
  Bell,
  CalendarClock,
  Calendar,
  Clock,
  Copy,
  Database,
  Download,
  FileArchive,
  Image as ImageIcon,
  ListChecks,
  MoreVertical,
  RefreshCw,
  Settings,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { projectsApi } from "@/api/projects";
import { classesApi } from "@/api/classes";
import { tasksApi, type Task } from "@/api/tasks";
import { statsApi, type ProjectStats } from "@/api/stats";
import { weightsApi } from "@/api/phase2";
import { RetrainDialog } from "@/components/annotation/RetrainDialog";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { ClassesEditor } from "./ClassesEditor";
import { NewTaskDialog } from "./NewTaskDialog";
import { DatasetsPage } from "./DatasetsPage";
import { AssetUploadDialog } from "./AssetUploadDialog";
import { ExportDialog } from "./ExportDialog";
import { ImportDialog } from "./ImportDialog";
// StatsPanel is dynamically imported so the recharts chunk lands in
// its own bundle and is fetched only when the stats UI is rendered.
const StatsPanel = lazy(() =>
  import("./StatsPanel").then((m) => ({ default: m.StatsPanel })),
);
import { Breadcrumbs } from "@/components/nav/Breadcrumbs";
import {
  TasksToolbar,
  type TaskSort,
  type TaskStatusFilter,
} from "@/components/tasks/TasksToolbar";
import { TaskRow } from "@/components/tasks/TaskRow";
import { useProjectPrefs } from "@/state/projectPrefs";
import { cn } from "@/lib/cn";
import { showToast } from "@/lib/toast";
import { Tag } from "lucide-react";
import { formatRelative } from "@/lib/relativeTime";

// ---------------------------------------------------------------------------
// Stat tile (used inside the totals strip)
// ---------------------------------------------------------------------------
function StatTile({
  label,
  value,
  testId,
}: {
  label: string;
  value: number;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "relative grid gap-2 rounded-2xl",
        "glass-surface glass-specular",
        "px-5 py-4 min-w-[140px]",
      )}
    >
      <span className="relative z-10 font-mono text-[36px] leading-none text-[color:var(--text-primary)] font-semibold tabular-tight">
        {value}
      </span>
      <span className="relative z-10 font-mono text-[10px] tracking-[0.18em] uppercase text-[color:var(--text-tertiary)] font-medium">
        {label}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plan-15 Phase 9 — upcoming-due strip. Surfaces the next 3 tasks closest
// to their due_date (overdue first) so the user can spot expiring work
// without scanning the full list.
// ---------------------------------------------------------------------------
type DueSeverity = "overdue" | "today" | "soon" | "watch" | "ok";

function dueSeverity(deltaMs: number): DueSeverity {
  const DAY = 24 * 60 * 60 * 1000;
  if (deltaMs < 0) return "overdue";
  if (deltaMs < DAY) return "today";
  if (deltaMs <= 3 * DAY) return "soon";
  if (deltaMs <= 7 * DAY) return "watch";
  return "ok";
}

function severityClasses(s: DueSeverity): {
  row: string;
  pill: string;
  icon: string;
} {
  switch (s) {
    case "overdue":
      return {
        row: "bg-[color-mix(in_oklch,var(--danger)_14%,transparent)] hover:bg-[color-mix(in_oklch,var(--danger)_22%,transparent)] text-[color:var(--danger)]",
        pill: "bg-[var(--danger)] text-white",
        icon: "text-[color:var(--danger)]",
      };
    case "today":
      return {
        row: "bg-[color-mix(in_oklch,var(--danger)_8%,transparent)] hover:bg-[color-mix(in_oklch,var(--danger)_14%,transparent)] text-[color:var(--danger)]",
        pill: "bg-[var(--danger)] text-white",
        icon: "text-[color:var(--danger)]",
      };
    case "soon":
      // DESIGN.md §2 — Warning Amber resolves to --warning so both
      // themes pull from the declared palette instead of hardcoded
      // #F59E0B.
      return {
        row: "bg-[color-mix(in_oklch,var(--warning)_10%,transparent)] hover:bg-[color-mix(in_oklch,var(--warning)_18%,transparent)] text-[color:var(--text-primary)]",
        pill: "bg-[var(--warning)] text-black",
        icon: "text-[color:var(--warning)]",
      };
    case "watch":
      // Less urgent than "soon" — same warning hue at 70% mix so it
      // reads as a quieter cousin without introducing a second amber.
      return {
        row: "hover:bg-[var(--bg-hover)] text-[color:var(--text-primary)]",
        pill: "bg-[color-mix(in_oklch,var(--warning)_70%,transparent)] text-black",
        icon: "text-[color:var(--warning)]",
      };
    default:
      return {
        row: "hover:bg-[var(--bg-hover)] text-[color:var(--text-primary)]",
        pill: "bg-[var(--bg-subtle)] text-[color:var(--text-secondary)]",
        icon: "text-[color:var(--text-tertiary)]",
      };
  }
}

function UpcomingDueStrip({
  projectId,
  tasks,
}: {
  projectId: string;
  tasks: Task[];
}) {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const ranked = tasks
    .filter((t) => t.due_date != null && t.archived_at == null)
    .map((t) => {
      const due = Date.parse(t.due_date as string);
      const ms = Number.isFinite(due) ? due - now : Number.POSITIVE_INFINITY;
      return { task: t, deltaMs: ms };
    })
    .sort((a, b) => a.deltaMs - b.deltaMs)
    .slice(0, 5);

  if (ranked.length === 0) return null;

  const overdueCount = ranked.filter((r) => r.deltaMs < 0).length;

  return (
    <section
      data-testid="project-upcoming-due"
      aria-label="Upcoming task deadlines"
      className={cn(
        "rounded-[var(--radius-md)] border p-3 transition-colors",
        overdueCount > 0
          ? "border-[var(--danger)] bg-[color-mix(in_oklch,var(--danger)_6%,var(--bg-elev))]"
          : "border-[var(--border-subtle)] bg-[var(--bg-elev)]",
      )}
    >
      <header className="flex items-center justify-between mb-2">
        <h3 className="text-[12px] font-medium tracking-tight text-[color:var(--text-primary)] inline-flex items-center gap-1.5">
          {overdueCount > 0 ? (
            <AlertTriangle className="h-3.5 w-3.5 text-[color:var(--danger)] animate-pulse" />
          ) : (
            <Bell className="h-3.5 w-3.5 text-[color:var(--text-tertiary)]" />
          )}
          Deadlines
          {overdueCount > 0 && (
            <span
              data-testid="upcoming-due-overdue-badge"
              className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full bg-[var(--danger)] text-white font-mono text-[10px] tabular-nums font-semibold"
            >
              {overdueCount}
            </span>
          )}
        </h3>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
          Next {ranked.length}
        </span>
      </header>
      <ul className="grid gap-0.5">
        {ranked.map(({ task, deltaMs }) => {
          const sev = dueSeverity(deltaMs);
          const cls = severityClasses(sev);
          const days = Math.round(deltaMs / DAY);
          const label =
            sev === "overdue"
              ? `${Math.abs(days)}d overdue`
              : sev === "today"
                ? "due today"
                : days === 1
                  ? "due tomorrow"
                  : `due in ${days}d`;
          const Icon = sev === "overdue" || sev === "today" ? AlertTriangle : Calendar;
          return (
            <li key={task.id}>
              <Link
                to="/projects/$projectId/tasks/$taskId"
                params={{ projectId, taskId: task.id }}
                data-testid={`upcoming-due-row-${task.id}`}
                data-severity={sev}
                className={cn(
                  "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)]",
                  "text-[12.5px] transition-colors",
                  cls.row,
                )}
              >
                <Icon className={cn("h-3.5 w-3.5 shrink-0", cls.icon)} />
                <span
                  className={cn(
                    "flex-1 truncate",
                    sev === "overdue" || sev === "today" ? "font-medium" : "",
                  )}
                >
                  {task.name}
                </span>
                <span
                  className={cn(
                    "font-mono text-[10px] tabular-nums uppercase tracking-[0.06em] px-1.5 py-0.5 rounded-full font-semibold",
                    cls.pill,
                  )}
                >
                  {label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Stats strip (totals + per-task progress + by_class chips). The previous
// implementation hid the by_class block behind `hidden aria-hidden`; that hack
// is gone — when there's data, we render real chips.
// ---------------------------------------------------------------------------
function ProjectStatsStrip({ stats }: { stats: ProjectStats }) {
  const { totals, by_class, tasks } = stats;
  const hasAny =
    totals.annotations > 0 ||
    totals.assets > 0 ||
    totals.tasks > 0 ||
    by_class.length > 0 ||
    tasks.length > 0;

  if (!hasAny) {
    return (
      <section
        data-testid="project-stats-empty"
        className="relative flex items-center gap-3 rounded-2xl glass-surface p-4"
      >
        <span className="grid h-8 w-8 place-items-center rounded-full bg-[var(--bg-subtle)] text-[color:var(--text-tertiary)]">
          <Sparkles className="h-4 w-4" />
        </span>
        <p className="text-[13px] text-[color:var(--text-secondary)]">
          No data yet — upload assets and start annotating to populate stats.
        </p>
      </section>
    );
  }

  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        <StatTile
          label="Annotations"
          value={totals.annotations}
          testId="project-stats-totals-annotations"
        />
        <StatTile
          label="Assets"
          value={totals.assets}
          testId="project-stats-totals-assets"
        />
        <StatTile
          label="Tasks"
          value={totals.tasks}
          testId="project-stats-totals-tasks"
        />
      </div>

      {by_class.length > 0 && (
        <div className="grid gap-1">
          <ul
            data-testid="project-stats-by-class"
            className="flex flex-nowrap gap-1.5 overflow-x-auto scrollbar-thin pb-1"
          >
            {[...by_class]
              .sort((a, b) => b.count - a.count)
              .map((c) => (
                <li key={c.class_id} className="shrink-0">
                  <Badge variant="ghost">
                    <span className="truncate max-w-[120px]">{c.name}</span>
                    <span className="font-mono text-[10px] tabular-nums text-[color:var(--text-tertiary)]">
                      {c.count}
                    </span>
                  </Badge>
                </li>
              ))}
          </ul>
          {by_class.length > 12 && (
            <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
              {by_class.length} classes — scroll horizontally
            </span>
          )}
        </div>
      )}

      {tasks.length > 0 && (
        <ProjectTaskProgressList tasks={tasks} />
      )}
    </section>
  );
}

// Plan-16 — capped, scrollable per-task progress list. Sorts by progress
// desc so the most-complete tasks surface first; renders the first 10
// inline and scrolls the remainder when the project has many tasks so
// the strip never blows up vertically.
function ProjectTaskProgressList({
  tasks,
}: {
  tasks: ProjectStats["tasks"];
}) {
  const sorted = [...tasks].sort(
    (a, b) => (b.progress_pct ?? 0) - (a.progress_pct ?? 0),
  );
  const isLarge = sorted.length > 10;
  return (
    <div
      className={cn(
        "grid",
        isLarge ? "max-h-[260px] overflow-y-auto scrollbar-thin pr-1" : "",
      )}
      data-testid="project-stats-task-progress-list"
    >
      <ul className="grid gap-1.5">
        {sorted.map((t) => {
          const pct = Math.round(
            Math.min(Math.max(t.progress_pct, 0), 1) * 100,
          );
          const widthPct = `${pct}%`;
          return (
            <li
              key={t.task_id}
              className="grid grid-cols-[1fr_60px] items-center gap-3 text-[12.5px]"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span
                  className="min-w-[80px] max-w-[200px] text-[color:var(--text-secondary)] tracking-tight truncate"
                  title={t.name}
                >
                  {t.name}
                </span>
                <div className="relative h-1 flex-1 overflow-hidden rounded-full bg-[var(--bg-hover)]">
                  <div
                    data-testid={`project-stats-task-bar-${t.task_id}`}
                    className="absolute inset-y-0 left-0 bg-[var(--accent)]"
                    style={{ width: widthPct }}
                  />
                </div>
              </div>
              <span className="text-right font-mono text-[10.5px] text-[color:var(--text-tertiary)] tabular-nums">
                {widthPct}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings tab — basic edit form for project name/description.
// ---------------------------------------------------------------------------
function ProjectSettingsForm({
  projectId,
  initialName,
  initialDescription,
}: {
  projectId: string;
  initialName: string;
  initialDescription: string | null;
}) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription ?? "");
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () =>
      projectsApi.update(projectId, {
        name,
        description: description.trim() || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  const dirty =
    name !== initialName || description !== (initialDescription ?? "");

  return (
    <form
      data-testid="project-settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!dirty || !name.trim()) return;
        m.mutate();
      }}
      className="grid gap-4 max-w-[640px]"
    >
      <Input
        id="project-name"
        type="text"
        label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />

      <Textarea
        id="project-description"
        label="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={3}
      />

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!dirty || !name.trim() || m.isPending}
          className={cn(
            "h-8 px-3 rounded-[var(--radius-sm)] text-[12.5px] font-medium tracking-tight",
            "bg-[var(--accent)] text-[color:var(--accent-fg)]",
            "hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed",
            "transition-colors",
          )}
        >
          {m.isPending ? "Saving…" : "Save changes"}
        </button>
        {m.isError && (
          <span className="text-[12px] text-[color:var(--danger)]">
            Save failed.
          </span>
        )}
        {m.isSuccess && !dirty && (
          <span className="text-[12px] text-[color:var(--success)]">Saved.</span>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Per-task 3-dot menu — Duplicate (v3.1 Bug 2). The user no longer wants
// the implicit ×3 fan-out; clicking Duplicate now opens a small dialog
// where the user types the new task's name.
// ---------------------------------------------------------------------------
function TaskRowMenu({
  task,
  pending,
  onDuplicate,
  onEditClasses,
  onEditDueDate,
  onRetrain,
  onArchive,
  onDelete,
}: {
  task: Task;
  pending: boolean;
  onDuplicate: () => void;
  onEditClasses: () => void;
  // Plan-16 — modify the task's due date inline.
  onEditDueDate?: () => void;
  // v3.4+ Phase 5 Task 6 -- Retrain YOLO on this task. Opens RetrainDialog.
  onRetrain?: () => void;
  // Plan-15 Track G -- archive (true) / unarchive (false). Caller drives
  // the mutation; the menu just toggles based on the task's current state.
  onArchive?: (archive: boolean) => void;
  // v3.8 -- Delete the task. Caller handles the confirm + mutation.
  onDelete?: () => void;
}) {
  const isArchived = task.archived_at != null;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          data-testid={`project-detail-task-menu-trigger-${task.id}`}
          aria-label={`More actions for task ${task.name}`}
          disabled={pending}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "grid w-9 shrink-0 place-items-center",
            "text-[color:var(--text-tertiary)]",
            "hover:bg-[var(--bg-subtle)] hover:text-[color:var(--text-primary)]",
            "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "transition-colors",
          )}
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          onClick={(e) => e.stopPropagation()}
          // DESIGN.md §1 / §6 — solid surface, compact 6px radius.
          className={cn(
            "z-[1000] min-w-[180px] rounded-[var(--radius-6)] p-1",
            "bg-[var(--bg-elev)] border border-[var(--border-subtle)]",
            "shadow-[var(--shadow-card)]",
          )}
        >
          <DropdownMenu.Item
            data-testid={`project-detail-task-duplicate-${task.id}`}
            onSelect={() => onDuplicate()}
            className={cn(
              "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px]",
              "cursor-pointer outline-none text-[color:var(--text-primary)]",
              "data-[highlighted]:bg-[var(--bg-hover)]",
            )}
          >
            <Copy className="h-3.5 w-3.5 text-[color:var(--text-tertiary)]" />
            <span className="flex-1">Duplicate</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            data-testid={`project-detail-task-edit-classes-${task.id}`}
            onSelect={() => onEditClasses()}
            className={cn(
              "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px]",
              "cursor-pointer outline-none text-[color:var(--text-primary)]",
              "data-[highlighted]:bg-[var(--bg-hover)]",
            )}
          >
            <Tag className="h-3.5 w-3.5 text-[color:var(--text-tertiary)]" />
            <span className="flex-1">Edit classes…</span>
          </DropdownMenu.Item>
          {onEditDueDate && (
            <DropdownMenu.Item
              data-testid={`project-detail-task-edit-due-${task.id}`}
              onSelect={() => onEditDueDate()}
              className={cn(
                "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px]",
                "cursor-pointer outline-none text-[color:var(--text-primary)]",
                "data-[highlighted]:bg-[var(--bg-hover)]",
              )}
            >
              <CalendarClock className="h-3.5 w-3.5 text-[color:var(--text-tertiary)]" />
              <span className="flex-1">
                {task.due_date ? "Change due date…" : "Set due date…"}
              </span>
            </DropdownMenu.Item>
          )}
          {onRetrain && (
            <DropdownMenu.Item
              data-testid={`project-detail-task-retrain-${task.id}`}
              onSelect={() => onRetrain()}
              className={cn(
                "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px]",
                "cursor-pointer outline-none text-[color:var(--text-primary)]",
                "data-[highlighted]:bg-[var(--bg-hover)]",
              )}
            >
              <RefreshCw className="h-3.5 w-3.5 text-[color:var(--text-tertiary)]" />
              <span className="flex-1">Retrain YOLO on this task</span>
            </DropdownMenu.Item>
          )}
          {onArchive && (
            <DropdownMenu.Item
              data-testid={`project-detail-task-archive-${task.id}`}
              onSelect={() => onArchive(!isArchived)}
              className={cn(
                "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px]",
                "cursor-pointer outline-none text-[color:var(--text-primary)]",
                "data-[highlighted]:bg-[var(--bg-hover)]",
              )}
            >
              {isArchived ? (
                <ArchiveRestore className="h-3.5 w-3.5 text-[color:var(--text-tertiary)]" />
              ) : (
                <Archive className="h-3.5 w-3.5 text-[color:var(--text-tertiary)]" />
              )}
              <span className="flex-1">
                {isArchived ? "Restore task" : "Archive task"}
              </span>
            </DropdownMenu.Item>
          )}
          {onDelete && (
            <DropdownMenu.Item
              data-testid={`project-detail-task-delete-${task.id}`}
              onSelect={() => onDelete()}
              className={cn(
                "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px]",
                "cursor-pointer outline-none text-[color:var(--danger)]",
                "data-[highlighted]:bg-[var(--danger-bg)]",
              )}
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span className="flex-1">Delete task…</span>
            </DropdownMenu.Item>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// ---------------------------------------------------------------------------
// v3.1 Issue 3 (Option A) — Per-task class subset chip used in the task
// row. Shows the task's *effective* class count. Clicking the chip opens
// the Edit-classes dialog.
// ---------------------------------------------------------------------------
function TaskClassesChip({
  projectId,
  taskId,
  onClick,
}: {
  projectId: string;
  taskId: string;
  onClick: () => void;
}) {
  const q = useQuery({
    queryKey: ["task-classes", projectId, taskId],
    queryFn: () => tasksApi.getClasses(projectId, taskId),
  });
  const count = q.data?.classes.length ?? 0;
  const isSubset = q.data?.allowed_class_ids !== null && q.data !== undefined;
  return (
    <button
      type="button"
      data-testid={`project-detail-task-classes-chip-${taskId}`}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onClick();
      }}
      title={
        isSubset
          ? `${count} classes (subset)`
          : `${count} classes (all project classes)`
      }
      className={cn(
        "inline-flex items-center gap-1 h-6 px-2 rounded-full",
        "border border-[var(--border-subtle)] bg-[var(--bg-subtle)]",
        "text-[10.5px] font-mono tabular-nums tracking-tight",
        "text-[color:var(--text-tertiary)]",
        "hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
        "transition-colors",
      )}
    >
      <Tag className="h-2.5 w-2.5" />
      {q.isLoading ? "…" : `${count} classes`}
      {isSubset && (
        <span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]"
        />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// v3.1 Issue 3 (Option A) — Edit-classes dialog. Lists all project
// classes as checkboxes; the task's current ``allowed_class_ids``
// determines initial checked state. ``Select all`` clears the subset
// (sends ``null`` so the task falls back to "all project classes").
// ``None`` confirms first then sends ``[]``.
// ---------------------------------------------------------------------------
function EditTaskClassesDialog({
  projectId,
  task,
  open,
  onClose,
}: {
  projectId: string;
  task: Task | null;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const taskId = task?.id ?? "";

  const projectClassesQ = useQuery({
    queryKey: ["classes", projectId],
    queryFn: () => classesApi.listForProject(projectId),
    enabled: open,
  });
  const taskClassesQ = useQuery({
    queryKey: ["task-classes", projectId, taskId],
    queryFn: () => tasksApi.getClasses(projectId, taskId),
    enabled: open && !!taskId,
  });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  // ``null`` mode = "use all project classes" (Select all). Otherwise the
  // mode is "explicit subset" and the actual list comes from ``selected``.
  const [mode, setMode] = useState<"all" | "subset">("all");

  // Sync local state with the loaded task's subset config every time the
  // dialog opens (or the task data arrives).
  useEffect(() => {
    if (!open) return;
    const allowed = taskClassesQ.data?.allowed_class_ids;
    if (allowed === null || allowed === undefined) {
      setMode("all");
      setSelected(new Set());
    } else {
      setMode("subset");
      setSelected(new Set(allowed));
    }
  }, [open, taskClassesQ.data?.allowed_class_ids]);

  const save = useMutation({
    mutationFn: async (allowed: string[] | null) =>
      tasksApi.setClasses(projectId, taskId, allowed),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["task-classes", projectId, taskId] });
      showToast("Task classes updated", { variant: "success" });
      onClose();
    },
    onError: () => {
      showToast("Failed to update task classes", { variant: "error" });
    },
  });

  const toggleClass = (classId: string) => {
    // When the user is in "all" mode (allowed_class_ids === null) every
    // checkbox renders as checked. The first toggle has to seed the
    // explicit-subset set from the *current* full project list so
    // unchecking "c1" leaves "c2", "c3" selected — not just removes c1
    // from an empty set.
    if (mode === "all") {
      const seed = new Set(projectClasses.map((c) => c.id));
      seed.delete(classId);
      setMode("subset");
      setSelected(seed);
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(classId)) {
        next.delete(classId);
      } else {
        next.add(classId);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    setMode("all");
    setSelected(new Set());
  };

  const handleNone = async () => {
    const ok = await confirm({
      title: "Allow no classes for this task?",
      description:
        "The task will have zero classes available. Existing annotations are preserved but no new classes can be picked. You can change this later.",
      confirmLabel: "Set to none",
      variant: "danger",
    });
    if (ok) {
      setMode("subset");
      setSelected(new Set());
    }
  };

  const handleSubmit = () => {
    const payload: string[] | null =
      mode === "all" ? null : Array.from(selected);
    save.mutate(payload);
  };

  const projectClasses = projectClassesQ.data ?? [];
  const isAllSelected = mode === "all";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent
        className="w-[min(92vw,520px)]"
        data-testid="task-classes-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            Edit classes{task ? ` — ${task.name}` : ""}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="flex items-center gap-2 text-[12px] text-[color:var(--text-secondary)]">
            <button
              type="button"
              data-testid="task-classes-select-all"
              onClick={handleSelectAll}
              className={cn(
                "h-7 px-2 rounded-[var(--radius-sm)] border text-[12px]",
                isAllSelected
                  ? "border-[var(--accent)] bg-[var(--bg-subtle)] text-[color:var(--text-primary)]"
                  : "border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]",
              )}
            >
              Select all
            </button>
            <button
              type="button"
              data-testid="task-classes-none"
              onClick={handleNone}
              className={cn(
                "h-7 px-2 rounded-[var(--radius-sm)] border text-[12px]",
                "border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]",
              )}
            >
              None
            </button>
            <span className="ml-auto font-mono text-[11px] text-[color:var(--text-tertiary)]">
              {isAllSelected
                ? `All (${projectClasses.length})`
                : `${selected.size} selected`}
            </span>
          </div>

          <div
            data-testid="task-classes-list"
            className="max-h-[320px] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]"
          >
            {projectClassesQ.isLoading && (
              <p className="px-3 py-2 text-[12px] text-[color:var(--text-tertiary)]">
                Loading classes…
              </p>
            )}
            {!projectClassesQ.isLoading && projectClasses.length === 0 && (
              <p className="px-3 py-3 text-[12px] italic text-[color:var(--text-tertiary)]">
                This project has no classes yet. Add classes from the
                project page first.
              </p>
            )}
            {projectClasses.map((c) => {
              const checked = isAllSelected || selected.has(c.id);
              return (
                <label
                  key={c.id}
                  className={cn(
                    "flex items-center gap-2.5 px-3 py-1.5 cursor-pointer",
                    "border-b border-[var(--border-subtle)] last:border-b-0",
                    "hover:bg-[var(--bg-hover)] transition-colors",
                  )}
                >
                  <Checkbox
                    data-testid={`task-classes-checkbox-${c.id}`}
                    checked={checked}
                    onChange={() => toggleClass(c.id)}
                  />
                  <span
                    aria-hidden
                    className="h-3 w-3 rounded-sm border border-[var(--border-subtle)]"
                    style={{ backgroundColor: c.color }}
                  />
                  <span className="font-mono text-[10.5px] text-[color:var(--text-tertiary)]">
                    {c.idx}
                  </span>
                  <span className="text-[12.5px] text-[color:var(--text-primary)] truncate">
                    {c.name}
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        <DialogFooter>
          <button
            type="button"
            data-testid="task-classes-cancel"
            onClick={onClose}
            className="h-8 px-3 rounded-[var(--radius-sm)] text-[12.5px] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)]"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="task-classes-save"
            disabled={save.isPending || !taskId}
            onClick={handleSubmit}
            className={cn(
              "h-8 px-3 rounded-[var(--radius-sm)] text-[12.5px] font-medium",
              "bg-[var(--accent)] text-[color:var(--accent-fg)]",
              "hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed",
            )}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Plan 14 Phase 8 Task 2 — task list rendered with extracted ``TaskRow``.
// ``hasAnyTasks`` distinguishes "no tasks at all" (empty-state copy) from
// "filtered to zero" (search/sort yielded nothing).
// ---------------------------------------------------------------------------
function FilteredTasksList({
  projectId,
  tasks,
  isLoading,
  hasAnyTasks,
  renderClassesChip,
  renderMenu,
  renderActions,
  getToggleComplete,
}: {
  projectId: string;
  tasks: Task[];
  isLoading: boolean;
  hasAnyTasks: boolean;
  renderClassesChip: (t: Task) => ReactNode;
  renderMenu: (t: Task) => ReactNode;
  renderActions?: (t: Task) => ReactNode;
  // Plan-21 — per-row completion toggle. Returns the click handler
  // and a `pending` flag so the IconButton can disable itself while
  // the PATCH is in flight. Optional so existing call sites keep
  // working until they wire it up.
  getToggleComplete?: (
    t: Task,
  ) => { onToggle: (next: boolean) => void; pending: boolean };
}) {
  if (!isLoading && !hasAnyTasks) {
    return (
      <EmptyState
        testId="project-detail-tasks-empty"
        icon={<ListChecks className="h-6 w-6" />}
        title="No tasks yet"
        description="A task groups a slice of assets into a labelling job. Create one to start annotating with the editor and tracking review progress."
        cta={{
          label: "New task",
          onClick: () => {
            // Surfaces the existing inline "New task" form on the page.
            // Dispatched as a custom event so the empty-state component
            // doesn't need to thread the dialog opener through props.
            if (typeof window !== "undefined") {
              window.dispatchEvent(
                new CustomEvent("carve:open-new-task-form"),
              );
            }
          },
        }}
      />
    );
  }

  if (!isLoading && tasks.length === 0) {
    return (
      <div
        data-testid="project-detail-tasks-no-match"
        className={cn(
          "rounded-[var(--radius-md)] border border-dashed border-[var(--border-subtle)]",
          "bg-[var(--bg-subtle)] px-4 py-3 text-[12.5px] text-[color:var(--text-tertiary)] italic",
        )}
      >
        No tasks match the current filter.
      </div>
    );
  }

  return (
    <ul className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] overflow-hidden">
      {tasks.map((t) => {
        const toggle = getToggleComplete?.(t);
        return (
          <TaskRow
            key={t.id}
            projectId={projectId}
            task={t}
            classesChip={renderClassesChip(t)}
            menuSlot={renderMenu(t)}
            actionsSlot={renderActions ? renderActions(t) : undefined}
            onToggleComplete={toggle?.onToggle}
            toggleCompletePending={toggle?.pending}
          />
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export function ProjectDetailPage({ projectId }: { projectId: string }) {
  const projectQ = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId),
  });
  // Plan-15 Track G — fetch with archived rows included; the toolbar
  // status filter (active / all / archived) decides which to render.
  const tasksQ = useQuery({
    queryKey: ["tasks", projectId, "with-archived"],
    queryFn: () =>
      tasksApi.listForProject(projectId, { includeArchived: true }),
  });
  const statsQ = useQuery({
    queryKey: ["project-stats", projectId],
    queryFn: () => statsApi.projectStats(projectId),
  });
  const qc = useQueryClient();
  const confirm = useConfirm();
  // v3.1 Bug 2 — Duplicate opens a name dialog; ×3 was removed because
  // users only want a single, named copy.
  // v3.2 Issue 4 — the dialog also includes a class checkbox grid so
  // the user can narrow the duplicate's subset at duplicate time.
  const [duplicateTarget, setDuplicateTarget] = useState<Task | null>(null);
  const [duplicateDraft, setDuplicateDraft] = useState<string>("");
  const [duplicateClasses, setDuplicateClasses] = useState<Set<string>>(
    new Set(),
  );
  // ``true`` = "use source's snapshot" (allowed_class_ids = null in
  // payload → backend keeps source list verbatim). When toggled OFF the
  // ``duplicateClasses`` set is sent as the override. Defaults to OFF
  // because the v3.2 Issue 3 fix snapshots classes at task creation, so
  // the user usually wants an explicit override here.
  const [duplicateUseSourceClasses, setDuplicateUseSourceClasses] =
    useState<boolean>(false);
  // v3.1 Issue 3 — per-task class subset dialog target.
  const [classesTarget, setClassesTarget] = useState<Task | null>(null);
  // v3.4+ Phase 5 Task 6 — task targeted by the retrain dialog. Null
  // closes the dialog. The dialog drives its own job-id polling.
  const [retrainTarget, setRetrainTarget] = useState<Task | null>(null);
  // Plan-16 — task targeted by the edit-due-date dialog.
  const [dueDateTarget, setDueDateTarget] = useState<Task | null>(null);
  // Plan-20.4 — per-task Upload / Export targets for the inline action
  // buttons rendered on each task row. Each is set when the user clicks
  // the row's icon and reset when the dialog closes.
  const [uploadTaskTarget, setUploadTaskTarget] = useState<Task | null>(null);
  const [exportTaskTarget, setExportTaskTarget] = useState<Task | null>(null);
  // Plan-20.9 — per-task Import target. Mirrors the upload/export
  // pattern; the dialog reused here is the same one mounted from the
  // task page's toolbar.
  const [importTaskTarget, setImportTaskTarget] = useState<Task | null>(null);

  // Plan 14 Phase 8 Task 2 — Tasks-toolbar state. Search is filtered
  // case-insensitively against task name; status uses the existing
  // task ``kind`` proxy (no archive flag in the API yet — falls back
  // to "all" for non-active filters until backend support lands).
  const [tasksQuery, setTasksQuery] = useState("");
  const [tasksStatus, setTasksStatus] =
    useState<TaskStatusFilter>("all");
  const [tasksSort, setTasksSort] = useState<TaskSort>("updated-desc");
  // Surface the new-task creator from the toolbar; the existing
  // ``NewTaskDialog`` controls its own open state via internal state,
  // so we mirror it with a counter to bump-trigger via ``key``.
  const [newTaskOpenSignal, setNewTaskOpenSignal] = useState(0);

  // Plan 14 Phase 8 Task 10 — the empty-state CTA dispatches this
  // ``carve:open-new-task-form`` event so the dialog/form opens without
  // having to thread the opener through deeply-nested props.
  useEffect(() => {
    function handler() {
      setNewTaskOpenSignal((n) => n + 1);
      if (typeof document !== "undefined") {
        document
          .querySelector('[data-testid="new-task-input"]')
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
    window.addEventListener("carve:open-new-task-form", handler);
    return () =>
      window.removeEventListener("carve:open-new-task-form", handler);
  }, []);

  // Plan 14 Phase 8 Task 2 — record this project as visited so the
  // projects index can surface it in the recent strip.
  const recordVisit = useProjectPrefs((s) => s.recordVisit);
  useEffect(() => {
    recordVisit(projectId);
  }, [recordVisit, projectId]);

  // Plan-15 Track G — honor the archived/active filter using the new
  // ``archived_at`` column.
  // Plan-21 — adds the "completed" chip and a secondary sort that pushes
  // completed tasks below active ones inside any view.
  const filteredTasks = useMemo(() => {
    const all = tasksQ.data ?? [];
    const q = tasksQuery.trim().toLowerCase();
    let result = all;
    if (q) {
      result = result.filter((t) => t.name.toLowerCase().includes(q));
    }
    if (tasksStatus === "archived") {
      result = result.filter((t) => t.archived_at != null);
    } else if (tasksStatus === "completed") {
      result = result.filter((t) => t.completed_at != null);
    } else if (tasksStatus === "active") {
      // Active = NOT completed AND NOT archived.
      result = result.filter(
        (t) => t.archived_at == null && t.completed_at == null,
      );
    }
    const next = [...result];
    next.sort((a, b) => {
      // Plan-21 — completed tasks always sort below active ones within
      // the same view, regardless of the secondary sort selection.
      const aDone = a.completed_at != null ? 1 : 0;
      const bDone = b.completed_at != null ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone;
      if (tasksSort === "name-asc") {
        return a.name.localeCompare(b.name);
      }
      // updated-desc — proxy via created_at until updated_at exists.
      return (
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
    });
    return next;
  }, [tasksQ.data, tasksQuery, tasksStatus, tasksSort]);

  // Plan-21 — completion summary for the project header strip.
  const completionSummary = useMemo(() => {
    const all = tasksQ.data ?? [];
    const total = all.length;
    const completed = all.filter((t) => t.completed_at != null).length;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { total, completed, percent };
  }, [tasksQ.data]);

  // Plan-21 — mark a task complete / in progress. Same toast pattern as
  // archive/unarchive; invalidates the tasks list so the row re-renders
  // with the green pill.
  const markComplete = useMutation({
    mutationFn: ({
      taskId,
      completed,
    }: {
      taskId: string;
      completed: boolean;
    }) => tasksApi.markComplete(projectId, taskId, completed),
    onSuccess: (_t, vars) => {
      qc.invalidateQueries({ queryKey: ["tasks", projectId] });
      qc.invalidateQueries({ queryKey: ["project-stats", projectId] });
      showToast(
        vars.completed
          ? "Task marked complete."
          : "Task marked in progress.",
        { variant: "success" },
      );
    },
    onError: () => {
      showToast("Failed to update task completion.", { variant: "error" });
    },
  });
  const projectWeightsQ = useQuery({
    queryKey: ["project-weights", projectId],
    queryFn: () => weightsApi.listForProject(projectId),
  });

  // v3.2 Issue 4 — load the source task's effective classes (for
  // pre-fill) plus the project's full class list (for the picker grid).
  const duplicateProjectClassesQ = useQuery({
    queryKey: ["classes", projectId],
    queryFn: () => classesApi.listForProject(projectId),
    enabled: duplicateTarget !== null,
  });
  const duplicateSourceClassesQ = useQuery({
    queryKey: ["task-classes", projectId, duplicateTarget?.id ?? ""],
    queryFn: () => tasksApi.getClasses(projectId, duplicateTarget!.id),
    enabled: duplicateTarget !== null,
  });

  // Pre-fill the picker every time the dialog opens for a new target or
  // the source-task's class list arrives.
  useEffect(() => {
    if (duplicateTarget === null) return;
    const allowed = duplicateSourceClassesQ.data?.allowed_class_ids;
    const projectClasses = duplicateProjectClassesQ.data ?? [];
    if (allowed === null || allowed === undefined) {
      // Source is in legacy "use all" mode → pre-fill with all project ids.
      setDuplicateClasses(new Set(projectClasses.map((c) => c.id)));
    } else {
      setDuplicateClasses(new Set(allowed));
    }
  }, [
    duplicateTarget,
    duplicateSourceClassesQ.data?.allowed_class_ids,
    duplicateProjectClassesQ.data,
  ]);

  const duplicateTask = useMutation({
    mutationFn: ({
      taskId,
      name,
      allowed_class_ids,
    }: {
      taskId: string;
      name: string;
      allowed_class_ids: string[] | null;
    }) => tasksApi.duplicate(projectId, taskId, 1, name, allowed_class_ids),
    onSuccess: (_created, vars) => {
      qc.invalidateQueries({ queryKey: ["tasks", projectId] });
      qc.invalidateQueries({ queryKey: ["project-stats", projectId] });
      showToast(`Duplicated as ${vars.name}`, { variant: "success" });
      setDuplicateTarget(null);
      setDuplicateDraft("");
      setDuplicateClasses(new Set());
      setDuplicateUseSourceClasses(false);
    },
    onError: () => {
      showToast("Failed to duplicate task", { variant: "error" });
    },
  });

  // v3.8 — task delete. Wired from TaskRowMenu's "Delete task..." item.
  const deleteTask = useMutation({
    mutationFn: (taskId: string) => tasksApi.delete(projectId, taskId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks", projectId] });
      qc.invalidateQueries({ queryKey: ["project-stats", projectId] });
      showToast("Task deleted.", { variant: "success" });
    },
    onError: () => {
      showToast("Failed to delete task.", { variant: "error" });
    },
  });

  // Plan-15 Track G — archive / unarchive task.
  const setTaskArchived = useMutation({
    mutationFn: ({ taskId, archived }: { taskId: string; archived: boolean }) =>
      archived
        ? tasksApi.archive(projectId, taskId)
        : tasksApi.unarchive(projectId, taskId),
    onSuccess: (_t, vars) => {
      qc.invalidateQueries({ queryKey: ["tasks", projectId] });
      // Plan-16 — archived tasks are excluded from stats; refresh now so
      // the chart and percentages re-render against the active subset.
      qc.invalidateQueries({ queryKey: ["project-stats", projectId] });
      showToast(vars.archived ? "Task archived." : "Task restored.", {
        variant: "success",
      });
    },
    onError: () => {
      showToast("Failed to update task.", { variant: "error" });
    },
  });

  // Plan-16 — patch a task's due_date. `null` clears it.
  const setTaskDueDate = useMutation({
    mutationFn: ({ taskId, dueDate }: { taskId: string; dueDate: string | null }) =>
      tasksApi.update(projectId, taskId, { due_date: dueDate }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks", projectId] });
      qc.invalidateQueries({ queryKey: ["project-stats", projectId] });
      showToast("Due date updated.", { variant: "success" });
    },
    onError: () => {
      showToast("Failed to update due date.", { variant: "error" });
    },
  });

  // Browser tab title — show the current project name.
  useEffect(() => {
    const name = projectQ.data?.name;
    if (!name) return;
    const previous = document.title;
    document.title = `${name} — Carve`;
    return () => {
      document.title = previous;
    };
  }, [projectQ.data?.name]);

  if (projectQ.isLoading)
    return (
      <p className="text-[color:var(--text-tertiary)] text-[13px]">Loading…</p>
    );
  if (projectQ.error || !projectQ.data)
    return (
      <p className="text-[color:var(--danger)] text-[13px]">
        Project not found.
      </p>
    );
  const project = projectQ.data;

  return (
    <div className="mx-auto grid max-w-[1100px] gap-5">
      {/* Plan 14 Phase 8 Task 2 — Workspace › <Project> breadcrumbs.
          Replaces the v3.7 single back-link with a multi-segment trail
          that scales as more nesting (task, asset) is added. */}
      <Breadcrumbs
        segments={[
          {
            label: "Workspace",
            to: "/projects",
            testId: "breadcrumb-workspace",
          },
          {
            label: project.name,
            testId: "breadcrumb-project",
          },
        ]}
      />
      {/* ---- Header ---- */}
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div className="grid gap-1">
          <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-[color:var(--text-tertiary)]">
            Project
          </span>
          <h1 className="font-editorial text-[36px] leading-[0.95] text-[color:var(--text-primary)]">
            {project.name}
          </h1>
          {project.description && (
            <p className="text-[12.5px] text-[color:var(--text-tertiary)] mt-0.5">
              {project.description}
            </p>
          )}
          {/* v3.3 Issue 2 — created_at + owner email meta row. */}
          <div
            data-testid="project-detail-meta"
            className="text-[11px] text-[color:var(--text-tertiary)] mt-1"
          >
            Created {formatRelative(project.created_at)} ·{" "}
            {project.owner_email ?? "Unknown"}
          </div>
        </div>
        <Link
          to="/projects/$projectId/stats"
          params={{ projectId }}
          data-testid="project-detail-view-stats-link"
          className={cn(
            "inline-flex items-center gap-1.5 h-8 px-3",
            "rounded-[var(--radius-sm)] border border-[var(--border-subtle)]",
            "text-[12.5px] tracking-tight text-[color:var(--text-secondary)]",
            "hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
            "transition-colors",
          )}
        >
          <BarChart3 className="h-3.5 w-3.5" />
          View stats
        </Link>
      </header>

      {/* Plan-21 — completion progress strip. Renders only once tasks
          have loaded so we don't flash 0/0 on first paint. The accent
          fill width animates over 600ms so newly-completed tasks read
          as a real signal, not a hard snap. */}
      {completionSummary.total > 0 && (
        <div
          data-testid="project-detail-completion-strip"
          className="grid gap-1.5"
        >
          <div className="flex items-baseline justify-between gap-2 text-[11.5px] text-[color:var(--text-tertiary)]">
            <span>
              <span className="font-mono tabular-nums text-[color:var(--text-secondary)]">
                {completionSummary.completed}
              </span>{" "}
              /{" "}
              <span className="font-mono tabular-nums">
                {completionSummary.total}
              </span>{" "}
              tasks completed
            </span>
            <span className="font-mono tabular-nums">
              {completionSummary.percent}%
            </span>
          </div>
          <div
            className="h-1 rounded-full bg-[var(--bg-subtle)] overflow-hidden"
            role="progressbar"
            aria-valuenow={completionSummary.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Project task completion"
          >
            <div
              data-testid="project-detail-completion-bar"
              className="h-full bg-[var(--success)] transition-[width] duration-[600ms] ease-out"
              style={{ width: `${completionSummary.percent}%` }}
            />
          </div>
        </div>
      )}

      <Tabs defaultValue="overview" data-testid="project-detail-tabs" variant="underline">
        <Tabs.List
          aria-label="Project sections"
          className="mb-5"
        >
          <Tabs.Trigger
            value="overview"
            data-testid="project-tab-overview"
          >
            <ImageIcon className="h-3.5 w-3.5" /> Overview
          </Tabs.Trigger>
          <Tabs.Trigger
            value="stats"
            data-testid="project-tab-stats"
          >
            <BarChart3 className="h-3.5 w-3.5" /> Stats
          </Tabs.Trigger>
          <Tabs.Trigger
            value="datasets"
            data-testid="project-tab-datasets"
          >
            <Database className="h-3.5 w-3.5" /> Datasets
          </Tabs.Trigger>
          <Tabs.Trigger
            value="settings"
            data-testid="project-tab-settings"
          >
            <Settings className="h-3.5 w-3.5" /> Settings
          </Tabs.Trigger>
        </Tabs.List>

        {/* ---- Overview tab ---- */}
        <Tabs.Content
          value="overview"
          className="grid gap-5 focus-visible:outline-none"
          data-testid="project-tab-content-overview"
        >
          {/* Stats strip */}
          {statsQ.isLoading && (
            <p className="text-[color:var(--text-tertiary)] text-[13px]">
              Loading stats…
            </p>
          )}
          {statsQ.data && <ProjectStatsStrip stats={statsQ.data} />}
          {statsQ.error && !statsQ.isLoading && (
            <section className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] p-4 text-[color:var(--text-tertiary)] text-[13px]">
              No data yet.
            </section>
          )}

          {/* Plan-15 Phase 9 follow-up — surface tasks that are overdue
              or due soon so the user does not miss expiring work. */}
          <UpcomingDueStrip projectId={projectId} tasks={tasksQ.data ?? []} />

          {/* Two-column layout — items-start so each column takes its natural
              content height. v2.6 work on ClassesEditor (max-h on its inner
              shell) is preserved; we simply stop forcing the Tasks column to
              match the Classes column height. */}
          <div
            data-testid="project-detail-overview-grid"
            className="grid gap-5 items-start grid-cols-1 lg:grid-cols-[2fr_1fr]"
          >
            <section
              data-testid="project-detail-tasks-section"
              className="grid gap-3"
            >
              <header className="flex items-center gap-2">
                <h2 className="text-[14px] font-medium tracking-tight text-[color:var(--text-primary)]">
                  Tasks
                </h2>
                <span
                  data-testid="project-detail-tasks-total"
                  className="font-mono text-[10.5px] text-[color:var(--text-tertiary)]"
                >
                  {tasksQ.data?.length ?? 0} total
                </span>
              </header>
              <TasksToolbar
                query={tasksQuery}
                onQueryChange={setTasksQuery}
                status={tasksStatus}
                onStatusChange={setTasksStatus}
                sort={tasksSort}
                onSortChange={setTasksSort}
                onNewTask={() => {
                  setNewTaskOpenSignal((n) => n + 1);
                  // Scroll the inline new-task form into view as a
                  // lightweight stand-in for a true modal trigger.
                  document
                    .querySelector('[data-testid="new-task-input"]')
                    ?.scrollIntoView({ behavior: "smooth", block: "center" });
                }}
              />
              <NewTaskDialog
                key={newTaskOpenSignal}
                projectId={projectId}
                onCreated={() => {}}
              />
              {tasksQ.isLoading && (
                <div
                  data-testid="tasks-loading-skeleton"
                  className="grid gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] p-2"
                >
                  {[0, 1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className={cn(
                        "h-12 rounded-[var(--radius-sm)]",
                        "bg-[var(--bg-subtle)] animate-pulse",
                      )}
                    />
                  ))}
                </div>
              )}
              <FilteredTasksList
                projectId={projectId}
                tasks={filteredTasks}
                isLoading={tasksQ.isLoading}
                hasAnyTasks={(tasksQ.data?.length ?? 0) > 0}
                getToggleComplete={(t) => ({
                  onToggle: (next) =>
                    markComplete.mutate({ taskId: t.id, completed: next }),
                  pending:
                    markComplete.isPending &&
                    markComplete.variables?.taskId === t.id,
                })}
                renderActions={(t) => (
                  <>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setUploadTaskTarget(t);
                      }}
                      title={`Upload assets to ${t.name}`}
                      data-testid={`task-row-upload-${t.id}`}
                      className={cn(
                        "grid h-7 w-7 place-items-center rounded-[var(--radius-sm)]",
                        "text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)] hover:bg-[var(--bg-hover)]",
                      )}
                    >
                      <Upload className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setImportTaskTarget(t);
                      }}
                      title={`Import annotations into ${t.name}`}
                      data-testid={`task-row-import-${t.id}`}
                      className={cn(
                        "grid h-7 w-7 place-items-center rounded-[var(--radius-sm)]",
                        "text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)] hover:bg-[var(--bg-hover)]",
                      )}
                    >
                      <FileArchive className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setExportTaskTarget(t);
                      }}
                      title={`Export annotations from ${t.name}`}
                      data-testid={`task-row-export-${t.id}`}
                      className={cn(
                        "grid h-7 w-7 place-items-center rounded-[var(--radius-sm)]",
                        "text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)] hover:bg-[var(--bg-hover)]",
                      )}
                    >
                      <Download className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
                renderClassesChip={(t) => (
                  <TaskClassesChip
                    projectId={projectId}
                    taskId={t.id}
                    onClick={() => setClassesTarget(t)}
                  />
                )}
                renderMenu={(t) => (
                  <TaskRowMenu
                    task={t}
                    pending={
                      duplicateTask.isPending &&
                      duplicateTask.variables?.taskId === t.id
                    }
                    onDuplicate={() => {
                      setDuplicateTarget(t);
                      setDuplicateDraft(`${t.name} (copy)`);
                    }}
                    onEditClasses={() => setClassesTarget(t)}
                    onEditDueDate={() => setDueDateTarget(t)}
                    onRetrain={() => setRetrainTarget(t)}
                    onArchive={(archive) =>
                      setTaskArchived.mutate({ taskId: t.id, archived: archive })
                    }
                    onDelete={async () => {
                      const ok = await confirm({
                        title: "Delete task?",
                        description: (
                          <>
                            Delete the task{" "}
                            <span className="font-medium text-[color:var(--text-primary)]">
                              {t.name}
                            </span>
                            ? All assets, frames, and annotations under it
                            will be removed. This cannot be undone.
                          </>
                        ),
                        variant: "danger",
                        confirmLabel: "Delete task",
                      });
                      if (ok) deleteTask.mutate(t.id);
                    }}
                  />
                )}
              />
            </section>
            <ClassesEditor projectId={projectId} />
          </div>
        </Tabs.Content>

        {/* ---- Stats tab ---- */}
        <Tabs.Content
          value="stats"
          className="focus-visible:outline-none"
          data-testid="project-tab-content-stats"
        >
          <Suspense fallback={null}>
            <StatsPanel projectId={projectId} />
          </Suspense>
        </Tabs.Content>

        {/* ---- Datasets tab (Plan-13 Phase 7 Task 7) ---- */}
        <Tabs.Content
          value="datasets"
          className="focus-visible:outline-none"
          data-testid="project-tab-content-datasets"
        >
          <DatasetsPage projectId={projectId} />
        </Tabs.Content>

        {/* ---- Settings tab ---- */}
        <Tabs.Content
          value="settings"
          className="focus-visible:outline-none"
          data-testid="project-tab-content-settings"
        >
          <ProjectSettingsForm
            projectId={projectId}
            initialName={project.name}
            initialDescription={project.description}
          />
        </Tabs.Content>
      </Tabs>

      {/* v3.1 Bug 2 + v3.2 Issue 4 — Duplicate-task dialog: name input
          plus a class-subset picker. The picker pre-fills with the
          source task's effective ``allowed_class_ids`` so the user can
          uncheck classes they do not want in the duplicate. */}
      <Dialog
        open={duplicateTarget !== null}
        onOpenChange={(o) => {
          if (!o) {
            setDuplicateTarget(null);
            setDuplicateDraft("");
            setDuplicateClasses(new Set());
            setDuplicateUseSourceClasses(false);
          }
        }}
      >
        <DialogContent className="w-[min(92vw,520px)]">
          <DialogHeader>
            <DialogTitle>Duplicate task</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!duplicateTarget) return;
              const next = duplicateDraft.trim();
              if (!next) return;
              const overrideIds: string[] | null = duplicateUseSourceClasses
                ? null
                : Array.from(duplicateClasses);
              duplicateTask.mutate({
                taskId: duplicateTarget.id,
                name: next,
                allowed_class_ids: overrideIds,
              });
            }}
          >
            <div className="grid gap-3">
              <Input
                type="text"
                autoFocus
                data-testid="duplicate-task-input"
                aria-label="New task name"
                value={duplicateDraft}
                onChange={(e) => setDuplicateDraft(e.target.value)}
                maxLength={120}
              />

              {/* v3.2 Issue 4 — class-subset picker. */}
              <div
                className="grid gap-2"
                data-testid="duplicate-task-classes-section"
              >
                <div className="flex items-center justify-between gap-2">
                  <label className="font-mono text-[10px] tracking-[0.18em] uppercase text-[color:var(--text-tertiary)]">
                    Classes
                  </label>
                  <label className="flex items-center gap-1.5 text-[11.5px] text-[color:var(--text-secondary)] cursor-pointer">
                    <Checkbox
                      data-testid="duplicate-task-use-source-classes"
                      checked={duplicateUseSourceClasses}
                      onChange={(e) =>
                        setDuplicateUseSourceClasses(e.target.checked)
                      }
                    />
                    Use source classes
                  </label>
                </div>
                <div
                  data-testid="duplicate-task-classes-list"
                  className={cn(
                    "max-h-[260px] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]",
                    duplicateUseSourceClasses && "opacity-50 pointer-events-none",
                  )}
                >
                  {duplicateProjectClassesQ.isLoading && (
                    <p className="px-3 py-2 text-[12px] text-[color:var(--text-tertiary)]">
                      Loading classes…
                    </p>
                  )}
                  {!duplicateProjectClassesQ.isLoading &&
                    (duplicateProjectClassesQ.data?.length ?? 0) === 0 && (
                      <p className="px-3 py-3 text-[12px] italic text-[color:var(--text-tertiary)]">
                        This project has no classes yet.
                      </p>
                    )}
                  {(duplicateProjectClassesQ.data ?? []).map((c) => {
                    const checked = duplicateClasses.has(c.id);
                    return (
                      <label
                        key={c.id}
                        className={cn(
                          "flex items-center gap-2.5 px-3 py-1.5 cursor-pointer",
                          "border-b border-[var(--border-subtle)] last:border-b-0",
                          "hover:bg-[var(--bg-hover)] transition-colors",
                        )}
                      >
                        <Checkbox
                          data-testid={`duplicate-task-class-${c.id}`}
                          checked={checked}
                          onChange={() => {
                            setDuplicateClasses((prev) => {
                              const next = new Set(prev);
                              if (next.has(c.id)) {
                                next.delete(c.id);
                              } else {
                                next.add(c.id);
                              }
                              return next;
                            });
                          }}
                        />
                        <span
                          aria-hidden
                          className="h-3 w-3 rounded-sm border border-[var(--border-subtle)]"
                          style={{ backgroundColor: c.color }}
                        />
                        <span className="font-mono text-[10.5px] text-[color:var(--text-tertiary)]">
                          {c.idx}
                        </span>
                        <span className="text-[12.5px] text-[color:var(--text-primary)] truncate">
                          {c.name}
                        </span>
                      </label>
                    );
                  })}
                </div>
                <span
                  data-testid="duplicate-task-classes-count"
                  className="font-mono text-[11px] text-[color:var(--text-tertiary)] self-end"
                >
                  {duplicateUseSourceClasses
                    ? "Using source's classes"
                    : `${duplicateClasses.size} selected`}
                </span>
              </div>
            </div>
            <DialogFooter>
              <button
                type="button"
                onClick={() => {
                  setDuplicateTarget(null);
                  setDuplicateDraft("");
                  setDuplicateClasses(new Set());
                  setDuplicateUseSourceClasses(false);
                }}
                data-testid="duplicate-task-cancel"
                className="h-8 px-3 rounded-[var(--radius-sm)] text-[12.5px] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              >
                Cancel
              </button>
              <button
                type="submit"
                data-testid="duplicate-task-save"
                disabled={!duplicateDraft.trim() || duplicateTask.isPending}
                className={cn(
                  "h-8 px-3 rounded-[var(--radius-sm)] text-[12.5px] font-medium",
                  "bg-[var(--accent)] text-[color:var(--accent-fg)]",
                  "hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed",
                )}
              >
                {duplicateTask.isPending ? "Duplicating…" : "Duplicate"}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Plan-20.4 — per-task Upload dialog launched from the task row's
          inline action button. */}
      <Dialog
        open={uploadTaskTarget !== null}
        onOpenChange={(o) => !o && setUploadTaskTarget(null)}
      >
        <DialogContent className="w-[min(92vw,560px)]">
          <DialogHeader>
            <DialogTitle>
              Upload assets{uploadTaskTarget ? ` — ${uploadTaskTarget.name}` : ""}
            </DialogTitle>
          </DialogHeader>
          {uploadTaskTarget && (
            <AssetUploadDialog
              projectId={projectId}
              taskId={uploadTaskTarget.id}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Plan-20.4 — per-task Export dialog launched from the task row's
          inline action button. */}
      <Dialog
        open={exportTaskTarget !== null}
        onOpenChange={(o) => !o && setExportTaskTarget(null)}
      >
        <DialogContent className="w-[min(92vw,640px)]">
          <DialogHeader>
            <DialogTitle>
              Export annotations{exportTaskTarget ? ` — ${exportTaskTarget.name}` : ""}
            </DialogTitle>
          </DialogHeader>
          {exportTaskTarget && (
            <ExportDialog
              projectId={projectId}
              taskId={exportTaskTarget.id}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Plan-20.9 — per-task Import dialog launched from the task row's
          inline action button. Same dialog as the task page's toolbar
          mount, just with a per-row trigger. */}
      <Dialog
        open={importTaskTarget !== null}
        onOpenChange={(o) => !o && setImportTaskTarget(null)}
      >
        <DialogContent className="w-[min(92vw,640px)]">
          <DialogHeader>
            <DialogTitle>
              Import annotations{importTaskTarget ? ` — ${importTaskTarget.name}` : ""}
            </DialogTitle>
          </DialogHeader>
          {importTaskTarget && (
            <ImportDialog taskId={importTaskTarget.id} />
          )}
        </DialogContent>
      </Dialog>

      {/* v3.1 Issue 3 (Option A) — per-task class subset dialog. */}
      <EditTaskClassesDialog
        projectId={projectId}
        task={classesTarget}
        open={classesTarget !== null}
        onClose={() => setClassesTarget(null)}
      />

      {/* v3.4+ Phase 5 Task 6 — Retrain YOLO dialog. */}
      <RetrainDialog
        open={retrainTarget !== null}
        onOpenChange={(o) => {
          if (!o) setRetrainTarget(null);
        }}
        task={retrainTarget}
        availableWeights={projectWeightsQ.data ?? []}
        onSuccess={() => {
          qc.invalidateQueries({ queryKey: ["project-weights", projectId] });
          showToast("New weight created. Pick it from the weight picker.", {
            variant: "success",
            duration: 4000,
          });
        }}
      />

      {/* Plan-16 — edit a task's due date. */}
      <EditDueDateDialog
        task={dueDateTarget}
        pending={setTaskDueDate.isPending}
        onClose={() => setDueDateTarget(null)}
        onSave={(iso) => {
          if (!dueDateTarget) return;
          setTaskDueDate.mutate(
            { taskId: dueDateTarget.id, dueDate: iso },
            { onSettled: () => setDueDateTarget(null) },
          );
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plan-16 — Edit due date dialog. Renders when a task is selected for due-
// date modification; "Clear" sets due_date to null. The form keeps a local
// YYYY-MM-DD string so the native <input type="date"> works without timezone
// surprises; on save it round-trips back to UTC midnight ISO.
// ---------------------------------------------------------------------------
interface EditDueDateDialogProps {
  task: Task | null;
  pending: boolean;
  onClose: () => void;
  onSave: (iso: string | null) => void;
}

function isoToDateInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // YYYY-MM-DD in UTC so we don't shift days due to local TZ.
  return d.toISOString().slice(0, 10);
}

function dateInputToIso(value: string): string {
  return `${value}T00:00:00Z`;
}

function EditDueDateDialog({ task, pending, onClose, onSave }: EditDueDateDialogProps) {
  const open = task != null;
  const [value, setValue] = useState(() => isoToDateInput(task?.due_date));

  useEffect(() => {
    if (open) setValue(isoToDateInput(task?.due_date));
  }, [open, task?.id, task?.due_date]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[min(92vw,420px)]">
        <DialogHeader>
          <DialogTitle>
            {task?.due_date ? "Change due date" : "Set due date"}
          </DialogTitle>
        </DialogHeader>
        {task && (
          <p className="text-[12.5px] text-[color:var(--text-secondary)] truncate">
            <span className="text-[color:var(--text-tertiary)]">Task:</span>{" "}
            <span className="font-medium text-[color:var(--text-primary)]">
              {task.name}
            </span>
          </p>
        )}
        <Input
          type="date"
          label="Due date"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          data-testid="edit-due-date-input"
        />
        <DialogFooter>
          {task?.due_date && (
            <button
              type="button"
              data-testid="edit-due-date-clear"
              onClick={() => onSave(null)}
              disabled={pending}
              className={cn(
                "h-8 px-3 rounded-[var(--radius-sm)] text-[12.5px]",
                "text-[color:var(--danger)] hover:bg-[var(--danger-bg)]",
                "disabled:opacity-50",
              )}
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className={cn(
              "h-8 px-3 rounded-[var(--radius-sm)] text-[12.5px]",
              "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)]",
              "disabled:opacity-50",
            )}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="edit-due-date-save"
            disabled={!value || pending}
            onClick={() => onSave(dateInputToIso(value))}
            className={cn(
              "h-8 px-3 rounded-[var(--radius-sm)] text-[12.5px] font-medium",
              "bg-[var(--accent)] text-white hover:opacity-90",
              "disabled:opacity-50",
            )}
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
