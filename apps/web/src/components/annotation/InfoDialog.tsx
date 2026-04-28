import { useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { useAnnotations, type AnnotationDraft, type AnnotationKind } from "@/state/annotations";
import type { Task } from "@/api/tasks";
import type { AssetWithUrl } from "@/api/assets";
import type { ClassRow } from "@/api/classes";
import { cn } from "@/lib/cn";

interface InfoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Current task (project + name + created_at). */
  task?: Task | null;
  /** Currently focused asset detail. */
  asset?: AssetWithUrl | null;
  /** Total assets in the task — used in the Overview row. */
  totalAssets?: number;
  /** Project classes — drives row order & label names in the stats table. */
  classes?: ClassRow[];
  /** Email of the user the task is assigned to (or current user for v2.6). */
  assigneeEmail?: string | null;
}

interface ClassStatRow {
  classId: string;
  label: string;
  bbox: number;
  polygon: number;
  mask: number;
  tag: number;
  manually: number;
  total: number;
}

/**
 * Tally a set of annotation drafts into per-class stats. Annotations whose
 * classId is not in `classes` are bucketed under a synthesized "Unknown"
 * row so a stale class deletion doesn't silently drop counts.
 */
export function aggregateAnnotationStats(
  byId: Record<string, AnnotationDraft>,
  classes: ClassRow[],
): { rows: ClassStatRow[]; totals: Omit<ClassStatRow, "classId" | "label"> } {
  const labelByClass: Record<string, string> = Object.fromEntries(
    classes.map((c) => [c.id, c.name]),
  );
  // Preserve project class order; append unknown classes at the end so the
  // user can still see counts that belong to no live class.
  const buckets: Record<string, ClassStatRow> = {};
  for (const c of classes) {
    buckets[c.id] = {
      classId: c.id,
      label: c.name,
      bbox: 0,
      polygon: 0,
      mask: 0,
      tag: 0,
      manually: 0,
      total: 0,
    };
  }

  for (const a of Object.values(byId)) {
    const classId = a.classId;
    if (!buckets[classId]) {
      buckets[classId] = {
        classId,
        label: labelByClass[classId] ?? "Unknown",
        bbox: 0,
        polygon: 0,
        mask: 0,
        tag: 0,
        manually: 0,
        total: 0,
      };
    }
    const b = buckets[classId];
    bumpKind(b, a.kind);
    // Without an interpolation pipeline (yet), every annotation is a
    // direct human/manual edit. Phase v2.6 leaves the "Manually" column
    // equal to total per class; future automation work can split it.
    b.manually += 1;
    b.total += 1;
  }

  // Drop empty rows (classes with zero annotations) to keep the table
  // dense; Total row still reflects everything.
  const rows = Object.values(buckets).filter((r) => r.total > 0);
  const totals = rows.reduce(
    (acc, r) => ({
      bbox: acc.bbox + r.bbox,
      polygon: acc.polygon + r.polygon,
      mask: acc.mask + r.mask,
      tag: acc.tag + r.tag,
      manually: acc.manually + r.manually,
      total: acc.total + r.total,
    }),
    { bbox: 0, polygon: 0, mask: 0, tag: 0, manually: 0, total: 0 },
  );
  return { rows, totals };
}

function bumpKind(row: ClassStatRow, kind: AnnotationKind): void {
  switch (kind) {
    case "bbox":
      row.bbox += 1;
      break;
    case "polygon":
      row.polygon += 1;
      break;
    case "mask":
      row.mask += 1;
      break;
    case "tag":
      row.tag += 1;
      break;
  }
}

function formatDate(iso: string | undefined | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
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
 * Info dialog — CVAT-style task overview + per-class annotation stats.
 *
 * Aggregates from the in-memory `useAnnotations` store, so counts react
 * live as the user creates or deletes annotations while the dialog stays
 * open. No backend round-trip; all data is already loaded by the editor.
 */
export function InfoDialog({
  open,
  onOpenChange,
  task,
  asset,
  totalAssets,
  classes,
  assigneeEmail,
}: InfoDialogProps) {
  const byId = useAnnotations((s) => s.byId);
  const { rows, totals } = useMemo(
    () => aggregateAnnotationStats(byId, classes ?? []),
    [byId, classes],
  );
  const totalAnnotations = totals.total;
  const overviewAssets =
    typeof totalAssets === "number" ? totalAssets : asset ? 1 : 0;
  const createdAt = task?.created_at ?? asset?.asset?.created_at ?? null;
  const assignee = assigneeEmail ?? "Nobody";

  if (!open) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(92vw,640px)]">
        <DialogHeader>
          <DialogTitle>Task info</DialogTitle>
          <DialogDescription>
            Overview of the current task and a per-class annotation breakdown.
          </DialogDescription>
        </DialogHeader>

        <section
          aria-labelledby="info-overview-heading"
          className="grid gap-2"
          data-testid="info-overview"
        >
          <h3
            id="info-overview-heading"
            className="text-[10.5px] uppercase tracking-[0.10em] text-[color:var(--text-tertiary)] font-medium"
          >
            Overview
          </h3>
          <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
            <OverviewRow label="Assignee" value={assignee} testId="info-assignee" />
            <OverviewRow
              label="Created at"
              value={formatDate(createdAt)}
              testId="info-created"
            />
            <OverviewRow
              label="Total assets"
              value={String(overviewAssets)}
              testId="info-total-assets"
            />
            <OverviewRow
              label="Annotations"
              value={String(totalAnnotations)}
              testId="info-total-annotations"
            />
          </dl>
        </section>

        <section
          aria-labelledby="info-stats-heading"
          className="mt-5 grid gap-2"
        >
          <h3
            id="info-stats-heading"
            className="text-[10.5px] uppercase tracking-[0.10em] text-[color:var(--text-tertiary)] font-medium"
          >
            Annotations statistics
          </h3>
          <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] overflow-hidden">
            <div className="max-h-[280px] overflow-auto">
              <table
                className="w-full border-collapse text-[12px]"
                data-testid="info-stats-table"
              >
                <thead className="sticky top-0 bg-[var(--bg-subtle)] z-10">
                  <tr>
                    <Th align="left">Label</Th>
                    <Th>Bbox</Th>
                    <Th>Polygon</Th>
                    <Th>Mask</Th>
                    <Th>Tag</Th>
                    <Th>Manually</Th>
                    <Th>Total</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={7}
                        className="px-3 py-6 text-center text-[color:var(--text-tertiary)] italic"
                        data-testid="info-stats-empty"
                      >
                        No annotations yet.
                      </td>
                    </tr>
                  ) : (
                    rows.map((r) => (
                      <tr
                        key={r.classId}
                        data-testid={`info-stats-row-${r.label}`}
                        className="border-t border-[var(--border-subtle)]"
                      >
                        <Td align="left" className="font-medium text-[color:var(--text-primary)]">
                          {r.label}
                        </Td>
                        <Td>{r.bbox}</Td>
                        <Td>{r.polygon}</Td>
                        <Td>{r.mask}</Td>
                        <Td>{r.tag}</Td>
                        <Td>{r.manually}</Td>
                        <Td className="font-medium text-[color:var(--text-primary)]">
                          {r.total}
                        </Td>
                      </tr>
                    ))
                  )}
                </tbody>
                {rows.length > 0 && (
                  <tfoot
                    className="sticky bottom-0 bg-[var(--bg-subtle)]"
                    data-testid="info-stats-totals"
                  >
                    <tr className="border-t border-[var(--border-strong)]">
                      <Td
                        align="left"
                        className="font-semibold text-[color:var(--text-primary)] uppercase tracking-[0.08em] text-[10.5px]"
                      >
                        Total
                      </Td>
                      <Td className="font-medium">{totals.bbox}</Td>
                      <Td className="font-medium">{totals.polygon}</Td>
                      <Td className="font-medium">{totals.mask}</Td>
                      <Td className="font-medium">{totals.tag}</Td>
                      <Td className="font-medium">{totals.manually}</Td>
                      <Td className="font-semibold text-[color:var(--text-primary)]">
                        {totals.total}
                      </Td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        </section>

        <DialogFooter>
          <Button
            variant="primary"
            size="sm"
            onClick={() => onOpenChange(false)}
            data-testid="info-dialog-ok"
          >
            OK
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OverviewRow({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}) {
  return (
    <>
      <dt className="text-[color:var(--text-tertiary)]">{label}</dt>
      <dd
        className="text-[color:var(--text-primary)] tabular-nums"
        data-testid={testId}
      >
        {value}
      </dd>
    </>
  );
}

function Th({
  children,
  align = "right",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={cn(
        "px-3 py-2 font-medium text-[10.5px] uppercase tracking-[0.10em] text-[color:var(--text-tertiary)]",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = "right",
  className,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td
      className={cn(
        "px-3 py-1.5 tabular-nums text-[color:var(--text-secondary)]",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      {children}
    </td>
  );
}
