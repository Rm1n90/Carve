// Armin Mehri — mehri.armin@gmail.com
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Calendar,
  ChevronRight,
  Clock,
  Image as ImageIcon,
  Video,
} from "lucide-react";
import type { ReactNode } from "react";
import type { Task } from "@/api/tasks";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { formatRelative } from "@/lib/relativeTime";

function formatShortDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

/**
 * Plan 14 Phase 8 Task 2 — task row used inside the project-detail
 * Tasks tab list. Extracted from the previous inline ``<li>`` block in
 * ``ProjectDetailPage.tsx`` so the row can grow extra metadata
 * (asset count, % annotated/accepted/rejected, last-activity) without
 * the page module ballooning past the 800-line guideline.
 *
 * Optional metric fields are nullable because the data is sourced from
 * separate stats queries — the row should still render the basics
 * before those land. The kebab menu is rendered via the ``menuSlot``
 * prop so the page can keep ownership of confirm-flows and dialogs.
 */
interface TaskRowProps {
  projectId: string;
  task: Task;
  /** Total assets attached to this task. ``null`` while loading. */
  assetCount?: number | null;
  /** Percentage 0..1 of frames annotated. */
  annotatedPct?: number | null;
  /** Percentage 0..1 of annotations accepted in review. */
  acceptedPct?: number | null;
  /** Percentage 0..1 of annotations rejected in review. */
  rejectedPct?: number | null;
  /** ISO 8601 timestamp of the last meaningful activity. */
  lastActivityAt?: string | null;
  /** Right-side classes chip (rendered by parent so it can wire its dialog). */
  classesChip?: ReactNode;
  /** Right-side kebab menu (rendered by parent — owns confirm flows). */
  menuSlot?: ReactNode;
  /** Plan-20.4 — inline action buttons (Upload / Export) rendered
   *  horizontally on each row so the user can fire those flows
   *  without entering the task. Parent owns the dialogs. */
  actionsSlot?: ReactNode;
}

function formatPct(pct: number | null | undefined): string | null {
  if (pct === null || pct === undefined) return null;
  const clamped = Math.min(Math.max(pct, 0), 1);
  return `${Math.round(clamped * 100)}%`;
}

export function TaskRow({
  projectId,
  task,
  assetCount,
  annotatedPct,
  acceptedPct,
  rejectedPct,
  lastActivityAt,
  classesChip,
  menuSlot,
  actionsSlot,
}: TaskRowProps) {
  const annotated = formatPct(annotatedPct);
  const accepted = formatPct(acceptedPct);
  const rejected = formatPct(rejectedPct);

  // Plan-15 Phase 9 follow-up — overdue highlight. A task is "overdue"
  // when its due_date has passed and it has not been archived.
  const dueIso = task.due_date ?? null;
  const dueMs = dueIso ? Date.parse(dueIso) : NaN;
  const isOverdue =
    !Number.isNaN(dueMs) && dueMs < Date.now() && task.archived_at == null;

  return (
    <li
      data-testid={`task-row-${task.id}`}
      data-overdue={isOverdue ? "true" : undefined}
      className={cn(
        "flex items-stretch border-b border-[var(--border-subtle)] last:border-b-0 transition-colors group",
        isOverdue
          ? "bg-[color-mix(in_oklch,var(--danger)_10%,transparent)] hover:bg-[color-mix(in_oklch,var(--danger)_18%,transparent)]"
          : "hover:bg-[var(--bg-hover)]",
      )}
    >
      <Link
        to="/projects/$projectId/tasks/$taskId"
        params={{ projectId, taskId: task.id }}
        data-testid={`project-detail-task-row-${task.id}`}
        className="flex flex-1 items-center gap-3 px-3 py-2 min-w-0"
      >
        <span className="grid h-6 w-6 place-items-center rounded-[var(--radius-sm)] bg-[var(--bg-subtle)] text-[color:var(--text-secondary)]">
          {task.kind === "video" ? (
            <Video className="h-3 w-3" />
          ) : (
            <ImageIcon className="h-3 w-3" />
          )}
        </span>
        <span className="flex-1 text-[12.5px] tracking-tight text-[color:var(--text-primary)] truncate">
          {task.name}
        </span>
        {assetCount !== undefined && assetCount !== null && (
          <span
            data-testid={`task-row-asset-count-${task.id}`}
            className="font-mono text-[10.5px] tabular-nums text-[color:var(--text-tertiary)]"
            title={`${assetCount} assets`}
          >
            {assetCount} assets
          </span>
        )}
        {annotated !== null && (
          <span
            data-testid={`task-row-annotated-${task.id}`}
            className={cn(
              "font-mono text-[10.5px] tabular-nums",
              "text-[color:var(--text-tertiary)]",
            )}
            title="Annotated"
          >
            {annotated} annotated
          </span>
        )}
        {accepted !== null && (
          <span
            data-testid={`task-row-accepted-${task.id}`}
            className="font-mono text-[10.5px] tabular-nums text-[color:var(--success)]"
            title="Accepted"
          >
            {accepted}✓
          </span>
        )}
        {rejected !== null && (
          <span
            data-testid={`task-row-rejected-${task.id}`}
            className="font-mono text-[10.5px] tabular-nums text-[color:var(--danger)]"
            title="Rejected"
          >
            {rejected}✗
          </span>
        )}
        {lastActivityAt && (
          <span
            data-testid={`task-row-activity-${task.id}`}
            className="font-mono text-[10.5px] text-[color:var(--text-tertiary)]"
            title={`Last activity ${lastActivityAt}`}
          >
            {formatRelative(lastActivityAt)}
          </span>
        )}
        <span
          data-testid={`task-row-created-${task.id}`}
          className="hidden md:inline-flex items-center gap-1 font-mono text-[10.5px] tabular-nums text-[color:var(--text-tertiary)]"
          title={`Created ${task.created_at}`}
        >
          <Clock aria-hidden className="h-3 w-3" />
          {formatShortDate(task.created_at)}
        </span>
        {dueIso && (
          <span
            data-testid={`task-row-due-${task.id}`}
            className={cn(
              "inline-flex items-center gap-1 font-mono text-[10.5px] tabular-nums px-1.5 py-0.5 rounded-[var(--radius-xs)]",
              isOverdue
                ? "text-[color:var(--danger)] bg-[color-mix(in_oklch,var(--danger)_18%,transparent)] font-medium"
                : "text-[color:var(--text-secondary)]",
            )}
            title={`Due ${dueIso}`}
          >
            {isOverdue ? (
              <AlertTriangle aria-hidden className="h-3 w-3" />
            ) : (
              <Calendar aria-hidden className="h-3 w-3" />
            )}
            {isOverdue ? "Overdue · " : "Due "}
            {formatShortDate(dueIso)}
          </span>
        )}
        {classesChip}
        <Badge variant="ghost">{task.kind}</Badge>
        <ChevronRight className="h-3.5 w-3.5 text-[color:var(--text-tertiary)] transition-transform group-hover:translate-x-0.5" />
      </Link>
      {actionsSlot && (
        <div
          className="flex items-center gap-1 pr-1"
          data-testid={`task-row-actions-${task.id}`}
        >
          {actionsSlot}
        </div>
      )}
      {menuSlot}
    </li>
  );
}
