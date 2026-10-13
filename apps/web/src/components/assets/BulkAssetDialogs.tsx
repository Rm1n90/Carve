// Armin Mehri — mehri.armin@gmail.com
//
// Bulk delete and bulk move of the images selected in a task's grid.
// Both dialogs ask the server first what the action would touch (how
// many images are annotated and with how many annotations, which
// classes the target task does not use, which names it already has)
// and say so before anything happens; the server refuses if the
// selection changed in between.
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import {
  assetsApi,
  type BulkMoveResult,
  type BulkPreview,
  type ClassCount,
} from "@/api/assets";
import { tasksApi } from "@/api/tasks";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Select } from "@/components/ui/Select";

const BUSY_TEXT: Record<string, string> = {
  logo_ai_running:
    "A Logo AI run is working on this task. Wait until it finishes (or cancel it), then try again.",
  job_running:
    "Another job (auto-annotate, YOLO, SAM, export) is working on this task. Wait until it finishes, then try again.",
};

function busyText(reason: string, taskName?: string): string {
  const text = BUSY_TEXT[reason] ?? "A job is working on this task. Try again when it has finished.";
  return taskName ? text.replace("this task", taskName) : text;
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

/** The server's reason for refusing, as words for the dialog. */
function refusal(err: unknown): string {
  const data = (err as { response?: { data?: { error?: string; reason?: string } } })?.response?.data;
  if (data?.error === "task_busy" && data.reason) return busyText(data.reason);
  if (data?.error === "selection_changed")
    return "The images or their annotations changed since this preview. Check it again before going ahead.";
  if (data?.error === "bad_target") return "These images can't go to that task.";
  if (data?.error === "not_project_owner" || data?.error === "data_movement_forbidden")
    return "Only the project owner or an admin can do this.";
  return "Something went wrong; nothing was changed.";
}

function ClassList({ classes, max = 8 }: { classes: ClassCount[]; max?: number }) {
  const shown = classes.slice(0, max);
  const rest = classes.slice(max).reduce((n, c) => n + c.count, 0);
  return (
    <ul className="flex flex-wrap gap-1.5" data-testid="bulk-class-list">
      {shown.map((c) => (
        <li
          key={c.class_id}
          className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[11.5px] text-secondary"
        >
          {c.name} <span className="text-tertiary">{c.count.toLocaleString()}</span>
        </li>
      ))}
      {rest > 0 && <li className="px-1 py-0.5 text-[11.5px] text-tertiary">+{rest.toLocaleString()} more</li>}
    </ul>
  );
}

function Note({ tone, children, testId }: { tone: "warn" | "danger" | "info"; children: React.ReactNode; testId?: string }) {
  return (
    <div
      data-testid={testId}
      className={
        tone === "info"
          ? "grid gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] p-3 text-[12.5px] text-secondary"
          : tone === "warn"
            ? "grid gap-1.5 rounded-[var(--radius-sm)] border border-[var(--warning,var(--accent))] p-3 text-[12.5px] text-secondary"
            : "grid gap-1.5 rounded-[var(--radius-sm)] border border-[var(--danger)] bg-[var(--danger-bg)] p-3 text-[12.5px] text-[color:var(--text-primary)]"
      }
    >
      {children}
    </div>
  );
}

interface BaseProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: string;
  assetIds: string[];
}

export function DeleteAssetsDialog({
  open,
  onOpenChange,
  taskId,
  assetIds,
  onDeleted,
}: BaseProps & { onDeleted: (result: { deleted: number; annotations_deleted: number }) => void }) {
  const [understood, setUnderstood] = useState(false);
  const idsKey = useMemo(() => assetIds.join(","), [assetIds]);
  const previewQ = useQuery({
    queryKey: ["bulk-preview", taskId, "delete", idsKey],
    queryFn: () => assetsApi.bulkPreview(taskId, assetIds),
    enabled: open && assetIds.length > 0,
    staleTime: 0,
  });
  const p: BulkPreview | undefined = previewQ.data;
  const del = useMutation({
    mutationFn: () => assetsApi.bulkDelete(taskId, assetIds, p?.annotations ?? 0),
    onSuccess: (r) => {
      onDeleted(r);
      onOpenChange(false);
    },
    onError: () => {
      void previewQ.refetch();
    },
  });
  const blocked = !p || !!p.busy || p.images === 0;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setUnderstood(false);
        onOpenChange(o);
      }}
    >
      <DialogContent className="w-[min(94vw,560px)]">
        <DialogHeader>
          <DialogTitle>Delete {plural(assetIds.length, "image")} permanently</DialogTitle>
          <DialogDescription>The images and everything annotated on them are removed for good.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3" data-testid="bulk-delete-body">
          {previewQ.isLoading && <p className="text-[12.5px] text-tertiary">Checking the selection…</p>}
          {previewQ.isError && <Note tone="danger">{refusal(previewQ.error)}</Note>}
          {p?.busy && (
            <Note tone="danger" testId="bulk-busy">
              {busyText(p.busy)}
            </Note>
          )}
          {p && p.annotations > 0 && (
            <Note tone="danger" testId="bulk-delete-annotated">
              <span>
                <strong>{plural(p.annotated_images, "image")}</strong> of these {p.annotated_images === 1 ? "is" : "are"}{" "}
                annotated: <strong>{plural(p.annotations, "annotation")}</strong> will be deleted with them.
              </span>
              <ClassList classes={p.by_class} />
            </Note>
          )}
          {p && p.annotations === 0 && p.images > 0 && (
            <Note tone="info" testId="bulk-delete-clean">
              None of these images has annotations.
            </Note>
          )}
          {del.isError && <Note tone="danger">{refusal(del.error)}</Note>}
          <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-secondary">
            <Checkbox
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
              data-testid="bulk-delete-understood"
            />
            I understand this cannot be undone
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={del.isPending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            data-testid="bulk-delete-confirm"
            disabled={blocked || !understood || del.isPending}
            loading={del.isPending}
            onClick={() => del.mutate()}
          >
            Delete {plural(p?.images ?? assetIds.length, "image")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MoveAssetsDialog({
  open,
  onOpenChange,
  projectId,
  taskId,
  assetIds,
  onMoved,
}: BaseProps & { projectId: string; onMoved: (result: BulkMoveResult, targetTaskId: string) => void }) {
  const [targetId, setTargetId] = useState("");
  const [missing, setMissing] = useState<"enable" | "drop">("enable");
  const idsKey = useMemo(() => assetIds.join(","), [assetIds]);
  const tasksQ = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => tasksApi.listForProject(projectId),
    enabled: open,
  });
  const source = tasksQ.data?.find((t) => t.id === taskId);
  const targets = (tasksQ.data ?? []).filter((t) => t.id !== taskId);
  const previewQ = useQuery({
    queryKey: ["bulk-preview", taskId, "move", targetId, idsKey],
    queryFn: () => assetsApi.bulkPreview(taskId, assetIds, targetId),
    enabled: open && assetIds.length > 0 && targetId !== "",
    staleTime: 0,
  });
  const p = previewQ.data;
  const t = p?.target;
  const move = useMutation({
    mutationFn: () =>
      assetsApi.bulkMove(taskId, {
        asset_ids: assetIds,
        target_task_id: targetId,
        missing_classes: missing,
        skip_duplicates: true,
        annotations_expected: p?.annotations ?? 0,
      }),
    onSuccess: (r) => {
      onMoved(r, targetId);
      onOpenChange(false);
    },
    onError: () => {
      void previewQ.refetch();
    },
  });
  const droppedCount = (t?.missing_classes ?? []).reduce((n, c) => n + c.count, 0);
  const blocked = !p || !t || !!p.busy || !!t.busy || !t.same_kind || t.to_move === 0;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setTargetId("");
          setMissing("enable");
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="w-[min(94vw,580px)]">
        <DialogHeader>
          <DialogTitle>Move {plural(assetIds.length, "image")} to another task</DialogTitle>
          <DialogDescription>
            The images go with their annotations. Nothing changes until you confirm.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3" data-testid="bulk-move-body">
          <label className="grid gap-1 text-[12px] text-secondary">
            Move to
            <Select value={targetId} onValueChange={setTargetId}>
              <Select.Trigger aria-label="Target task" data-testid="bulk-move-target">
                <Select.Value placeholder="Pick a task of this project" />
              </Select.Trigger>
              <Select.Content>
                {targets.map((task) => (
                  <Select.Item
                    key={task.id}
                    value={task.id}
                    disabled={source !== undefined && task.kind !== source.kind}
                    data-testid={`bulk-move-target-${task.id}`}
                  >
                    {task.name}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
          </label>
          {targetId === "" && <p className="text-[12.5px] text-tertiary">Pick the task to move them to.</p>}
          {previewQ.isLoading && <p className="text-[12.5px] text-tertiary">Checking the selection…</p>}
          {previewQ.isError && <Note tone="danger">{refusal(previewQ.error)}</Note>}
          {p?.busy && <Note tone="danger" testId="bulk-busy">{busyText(p.busy, source?.name)}</Note>}
          {t?.busy && <Note tone="danger" testId="bulk-target-busy">{busyText(t.busy, t.name)}</Note>}
          {t && !t.same_kind && (
            <Note tone="danger">{t.name} holds a different kind of asset; these images can't go there.</Note>
          )}
          {p && t && t.same_kind && (
            <Note tone="info" testId="bulk-move-summary">
              <span>
                <strong>{plural(t.to_move, "image")}</strong> will move to <strong>{t.name}</strong>
                {t.annotations_to_move > 0
                  ? ` with ${plural(t.annotations_to_move, "annotation")}.`
                  : " (none of them annotated)."}
              </span>
              {t.already_in_target > 0 && (
                <span data-testid="bulk-move-duplicates">
                  {plural(t.already_in_target, "image")} {t.already_in_target === 1 ? "is" : "are"} already in{" "}
                  {t.name} (the same file) and stay{t.already_in_target === 1 ? "s" : ""} here.
                </span>
              )}
              {t.renamed > 0 && (
                <span data-testid="bulk-move-renamed">
                  {plural(t.renamed, "file name")} already exist{t.renamed === 1 ? "s" : ""} in {t.name}: those
                  images get their id added to the name (photo_1a2b3c4d.jpg), so exports don't overwrite each other.
                </span>
              )}
            </Note>
          )}
          {t && t.missing_classes.length > 0 && (
            <Note tone="warn" testId="bulk-move-missing-classes">
              <span className="inline-flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5" />
                {t.name} doesn't use {t.missing_classes.length === 1 ? "this class" : "these classes"} of the moving
                annotations:
              </span>
              <ClassList classes={t.missing_classes} />
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="missing-classes"
                  checked={missing === "enable"}
                  onChange={() => setMissing("enable")}
                  data-testid="bulk-move-enable"
                />
                Enable {t.missing_classes.length === 1 ? "it" : "them"} in {t.name} and keep the annotations
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="missing-classes"
                  checked={missing === "drop"}
                  onChange={() => setMissing("drop")}
                  data-testid="bulk-move-drop"
                />
                Delete those {plural(droppedCount, "annotation")}
              </label>
            </Note>
          )}
          {move.isError && <Note tone="danger">{refusal(move.error)}</Note>}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={move.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            data-testid="bulk-move-confirm"
            disabled={blocked || move.isPending}
            loading={move.isPending}
            onClick={() => move.mutate()}
          >
            Move {plural(t?.to_move ?? assetIds.length, "image")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
