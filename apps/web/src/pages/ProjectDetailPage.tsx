import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as Tabs from "@radix-ui/react-tabs";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Copy,
  Image as ImageIcon,
  MoreVertical,
  Settings,
  Sparkles,
  Video,
} from "lucide-react";
import { projectsApi } from "@/api/projects";
import { classesApi } from "@/api/classes";
import { tasksApi, type Task } from "@/api/tasks";
import { statsApi, type ProjectStats } from "@/api/stats";
import { Badge } from "@/components/ui/Badge";
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
import { StatsPanel } from "./StatsPanel";
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
        <ul
          data-testid="project-stats-by-class"
          className="flex flex-nowrap gap-1.5 overflow-x-auto scrollbar-thin"
        >
          {by_class.slice(0, 8).map((c) => (
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
      )}

      {tasks.length > 0 && (
        <ul className="grid gap-1.5">
          {tasks.map((t) => {
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
      )}
    </section>
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
      <div className="grid gap-1.5">
        <label
          htmlFor="project-name"
          className="text-[12px] uppercase tracking-[0.08em] text-[color:var(--text-tertiary)]"
        >
          Name
        </label>
        <input
          id="project-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={cn(
            "h-9 px-2.5 rounded-[var(--radius-sm)]",
            "bg-[var(--bg-sunken)] text-[color:var(--text-primary)]",
            "border border-[var(--border-subtle)] text-[13px]",
            "focus:outline-none focus:border-[var(--accent)]",
          )}
        />
      </div>

      <div className="grid gap-1.5">
        <label
          htmlFor="project-description"
          className="text-[12px] uppercase tracking-[0.08em] text-[color:var(--text-tertiary)]"
        >
          Description
        </label>
        <textarea
          id="project-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className={cn(
            "px-2.5 py-2 rounded-[var(--radius-sm)] resize-y",
            "bg-[var(--bg-sunken)] text-[color:var(--text-primary)]",
            "border border-[var(--border-subtle)] text-[13px]",
            "focus:outline-none focus:border-[var(--accent)]",
          )}
        />
      </div>

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
}: {
  task: Task;
  pending: boolean;
  onDuplicate: () => void;
  onEditClasses: () => void;
}) {
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
          className="z-[1000] min-w-[180px] rounded-[var(--radius-md)] glass-surface-strong p-1"
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
                  <input
                    type="checkbox"
                    data-testid={`task-classes-checkbox-${c.id}`}
                    checked={checked}
                    onChange={() => toggleClass(c.id)}
                    className="h-3.5 w-3.5 accent-[var(--accent)]"
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
// Tab trigger styling — same look as AnnotateAssetPage tabs.
// ---------------------------------------------------------------------------
const tabTriggerClass = cn(
  "px-3 py-1.5 text-[12.5px] tracking-tight rounded-t-[var(--radius-sm)]",
  "text-[color:var(--text-tertiary)] border-b-2 border-transparent",
  "hover:text-[color:var(--text-primary)]",
  "data-[state=active]:text-[color:var(--text-primary)]",
  "data-[state=active]:border-[var(--accent)]",
  "transition-colors flex items-center gap-1.5",
);

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export function ProjectDetailPage({ projectId }: { projectId: string }) {
  const projectQ = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId),
  });
  const tasksQ = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => tasksApi.listForProject(projectId),
  });
  const statsQ = useQuery({
    queryKey: ["project-stats", projectId],
    queryFn: () => statsApi.projectStats(projectId),
  });
  const qc = useQueryClient();
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
      {/* v3.7 Issue 6 — back link to the projects list, mirroring the
          stats-page pattern from v3.0 so users have a consistent
          breadcrumb-style return path. */}
      <Link
        to="/projects"
        data-testid="project-detail-back-link"
        className="inline-flex items-center gap-1 text-[12.5px] tracking-tight text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)] transition-colors w-fit"
      >
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
        Back to projects
      </Link>
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

      <Tabs.Root defaultValue="overview" data-testid="project-detail-tabs">
        <Tabs.List
          aria-label="Project sections"
          className="flex border-b border-[var(--border-subtle)] gap-1 mb-5"
        >
          <Tabs.Trigger
            value="overview"
            className={tabTriggerClass}
            data-testid="project-tab-overview"
          >
            <ImageIcon className="h-3.5 w-3.5" /> Overview
          </Tabs.Trigger>
          <Tabs.Trigger
            value="stats"
            className={tabTriggerClass}
            data-testid="project-tab-stats"
          >
            <BarChart3 className="h-3.5 w-3.5" /> Stats
          </Tabs.Trigger>
          <Tabs.Trigger
            value="settings"
            className={tabTriggerClass}
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
              <NewTaskDialog projectId={projectId} onCreated={() => {}} />
              {tasksQ.isLoading && (
                <p className="text-[color:var(--text-tertiary)] text-[13px]">
                  Loading tasks…
                </p>
              )}
              <ul className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] overflow-hidden">
                {tasksQ.data?.map((t) => (
                  <li
                    key={t.id}
                    className="flex items-stretch border-b border-[var(--border-subtle)] last:border-b-0 hover:bg-[var(--bg-hover)] transition-colors group"
                  >
                    <Link
                      to="/projects/$projectId/tasks/$taskId"
                      params={{ projectId, taskId: t.id }}
                      data-testid={`project-detail-task-row-${t.id}`}
                      className="flex flex-1 items-center gap-3 px-3 py-2 min-w-0"
                    >
                      <span className="grid h-6 w-6 place-items-center rounded-[var(--radius-sm)] bg-[var(--bg-subtle)] text-[color:var(--text-secondary)]">
                        {t.kind === "video" ? (
                          <Video className="h-3 w-3" />
                        ) : (
                          <ImageIcon className="h-3 w-3" />
                        )}
                      </span>
                      <span className="flex-1 text-[12.5px] tracking-tight text-[color:var(--text-primary)] truncate">
                        {t.name}
                      </span>
                      <TaskClassesChip
                        projectId={projectId}
                        taskId={t.id}
                        onClick={() => setClassesTarget(t)}
                      />
                      <Badge variant="ghost">{t.kind}</Badge>
                      <ChevronRight className="h-3.5 w-3.5 text-[color:var(--text-tertiary)] transition-transform group-hover:translate-x-0.5" />
                    </Link>
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
                    />
                  </li>
                ))}
                {(tasksQ.data?.length ?? 0) === 0 && !tasksQ.isLoading && (
                  <li className="text-[color:var(--text-tertiary)] text-[13px] italic px-4 py-3">
                    No tasks yet.
                  </li>
                )}
              </ul>
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
          <StatsPanel projectId={projectId} />
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
      </Tabs.Root>

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
              <input
                type="text"
                autoFocus
                data-testid="duplicate-task-input"
                aria-label="New task name"
                value={duplicateDraft}
                onChange={(e) => setDuplicateDraft(e.target.value)}
                maxLength={120}
                className={cn(
                  "w-full h-9 px-2.5 rounded-[var(--radius-sm)]",
                  "bg-[var(--bg-subtle)] text-[color:var(--text-primary)]",
                  "border border-[var(--border-subtle)]",
                  "outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]",
                  "text-[13px]",
                )}
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
                    <input
                      type="checkbox"
                      data-testid="duplicate-task-use-source-classes"
                      checked={duplicateUseSourceClasses}
                      onChange={(e) =>
                        setDuplicateUseSourceClasses(e.target.checked)
                      }
                      className="h-3.5 w-3.5 accent-[var(--accent)]"
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
                        <input
                          type="checkbox"
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
                          className="h-3.5 w-3.5 accent-[var(--accent)]"
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

      {/* v3.1 Issue 3 (Option A) — per-task class subset dialog. */}
      <EditTaskClassesDialog
        projectId={projectId}
        task={classesTarget}
        open={classesTarget !== null}
        onClose={() => setClassesTarget(null)}
      />
    </div>
  );
}
