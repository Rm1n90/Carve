// Armin Mehri — mehri.armin@gmail.com
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  datasetsApi,
  type DatasetDiff,
  type DatasetVersionRow,
} from "@/api/datasets";
import { membersApi, type Role } from "@/api/members";
import { useAuth } from "@/auth/store";
import { Database } from "lucide-react";
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
import { Tabs } from "@/components/ui/Tabs";
import { cn } from "@/lib/cn";
import { showToast } from "@/lib/toast";
import { formatRelative } from "@/lib/relativeTime";

const KIND_LABEL: Record<string, string> = {
  retrain: "retrain",
  export: "export",
  manual: "manual",
  rollback_pre: "rollback (pre)",
  rollback_post: "rollback (post)",
};

function KindChip({ kind }: { kind: string }) {
  return (
    <Badge variant="ghost" data-testid={`dataset-kind-chip-${kind}`}>
      {KIND_LABEL[kind] ?? kind}
    </Badge>
  );
}

interface SummaryNumbers {
  annotations: number;
  accepted: number;
  rejected: number;
}

function summaryNumbers(row: DatasetVersionRow): SummaryNumbers {
  const s = row.summary ?? {};
  return {
    annotations: typeof s.annotations === "number" ? s.annotations : 0,
    accepted: typeof s.accepted === "number" ? s.accepted : 0,
    rejected: typeof s.rejected === "number" ? s.rejected : 0,
  };
}

interface CompareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  a: DatasetVersionRow | null;
  b: DatasetVersionRow | null;
}

function CompareDialog({ open, onOpenChange, projectId, a, b }: CompareDialogProps) {
  const enabled = open && !!a && !!b;
  const q = useQuery({
    queryKey: ["dataset-diff", projectId, a?.id, b?.id],
    queryFn: () => datasetsApi.diff(projectId, a!.id, b!.id),
    enabled,
  });
  const [tab, setTab] = useState<"by_class" | "by_image">("by_class");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(94vw,820px)]">
        <DialogHeader>
          <div data-testid="dataset-compare-dialog" hidden />
          <DialogTitle>
            Compare datasets
            {a && b ? ` — ${a.label} vs ${b.label}` : ""}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3" data-testid="dataset-compare-summary">
            {[a, b].map((row, idx) => {
              if (!row) return <div key={idx} />;
              const n = summaryNumbers(row);
              return (
                <div
                  key={row.id}
                  className="grid gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-3"
                  data-testid={`dataset-compare-side-${idx}`}
                >
                  <div className="flex items-center gap-2">
                    <KindChip kind={row.kind} />
                    <span className="text-[12.5px] truncate" title={row.label}>
                      {row.label}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2 text-[11px] font-mono text-[color:var(--text-tertiary)]">
                    <span>annotations: {n.annotations}</span>
                    <span>accepted: {n.accepted}</span>
                    <span>rejected: {n.rejected}</span>
                  </div>
                </div>
              );
            })}
          </div>

          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as typeof tab)}
            variant="underline"
          >
            <Tabs.List aria-label="Diff view">
              {(["by_class", "by_image"] as const).map((t) => (
                <Tabs.Trigger
                  key={t}
                  value={t}
                  data-testid={`dataset-compare-tab-${t}`}
                >
                  {t === "by_class" ? "By class" : "By image"}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
          </Tabs>

          {q.isLoading && (
            <p className="text-[12.5px] text-[color:var(--text-tertiary)]">
              Loading diff…
            </p>
          )}
          {q.isError && (
            <p className="text-[12.5px] text-[color:var(--danger)]">
              Failed to load diff.
            </p>
          )}
          {q.data && tab === "by_class" && <ByClassPanel diff={q.data} />}
          {q.data && tab === "by_image" && <ByImagePanel diff={q.data} />}
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            data-testid="dataset-compare-close"
            className="h-8 px-3 rounded-[var(--radius-6)] text-[12.5px] text-[color:var(--text-secondary)] transition-colors duration-[180ms] ease-out hover:bg-[var(--bg-hover)]"
          >
            Close
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ByClassPanel({ diff }: { diff: DatasetDiff }) {
  const classes = useMemo(() => {
    const set = new Set<string>([
      ...Object.keys(diff.added),
      ...Object.keys(diff.removed),
      ...Object.keys(diff.changed),
    ]);
    return Array.from(set).sort();
  }, [diff]);

  if (classes.length === 0) {
    return (
      <p
        className="text-[12.5px] italic text-[color:var(--text-tertiary)]"
        data-testid="dataset-compare-by-class-empty"
      >
        No class-level differences detected.
      </p>
    );
  }

  return (
    <ul className="grid gap-2" data-testid="dataset-compare-by-class">
      {classes.map((cls) => {
        const added = diff.added[cls] ?? 0;
        const removed = diff.removed[cls] ?? 0;
        return (
          <li
            key={cls}
            className="grid grid-cols-[120px_1fr_1fr] items-center gap-3 text-[12px]"
            data-testid={`dataset-compare-by-class-row-${cls}`}
          >
            <span className="truncate font-medium text-[color:var(--text-primary)]">
              {cls}
            </span>
            <div className="flex items-center gap-2" title={`added ${added}`}>
              <span className="font-mono text-[10.5px] tabular-nums text-[color:var(--success)]">
                +{added}
              </span>
              <div className="h-1 flex-1 rounded-full bg-[var(--bg-hover)]">
                <div
                  className="h-full rounded-full bg-[var(--success)]"
                  style={{ width: `${Math.min(100, added * 4)}%` }}
                />
              </div>
            </div>
            <div className="flex items-center gap-2" title={`removed ${removed}`}>
              <span className="font-mono text-[10.5px] tabular-nums text-[color:var(--danger)]">
                -{removed}
              </span>
              <div className="h-1 flex-1 rounded-full bg-[var(--bg-hover)]">
                <div
                  className="h-full rounded-full bg-[var(--danger)]"
                  style={{ width: `${Math.min(100, removed * 4)}%` }}
                />
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ByImagePanel({ diff }: { diff: DatasetDiff }) {
  const PAGE = 25;
  const [page, setPage] = useState(0);
  const total = diff.by_image.length;
  const slice = diff.by_image.slice(page * PAGE, (page + 1) * PAGE);
  const lastPage = Math.max(0, Math.ceil(total / PAGE) - 1);

  if (total === 0) {
    return (
      <p
        className="text-[12.5px] italic text-[color:var(--text-tertiary)]"
        data-testid="dataset-compare-by-image-empty"
      >
        No per-image differences.
      </p>
    );
  }

  return (
    <div className="grid gap-2" data-testid="dataset-compare-by-image">
      <div className="max-h-[280px] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border-subtle)]">
        <table className="w-full text-[12px]">
          <thead className="text-[10.5px] uppercase tracking-[0.08em] text-[color:var(--text-tertiary)]">
            <tr>
              <th className="text-left px-3 py-2">Image</th>
              <th className="text-right px-3 py-2 w-[80px]">Added</th>
              <th className="text-right px-3 py-2 w-[80px]">Removed</th>
              <th className="text-right px-3 py-2 w-[80px]">Changed</th>
            </tr>
          </thead>
          <tbody>
            {slice.map((row) => (
              <tr key={row.image} className="border-t border-[var(--border-subtle)]">
                <td className="px-3 py-1.5 truncate max-w-[240px]" title={row.image}>
                  {row.image}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-[color:var(--success)]">
                  +{row.added}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-[color:var(--danger)]">
                  -{row.removed}
                </td>
                <td className="px-3 py-1.5 text-right font-mono">
                  ~{row.changed}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between text-[11px] text-[color:var(--text-tertiary)]">
        <span>
          Page {page + 1} / {lastPage + 1} · {total} rows
        </span>
        <div className="flex gap-1">
          <button
            type="button"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="h-6 px-2 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] disabled:opacity-40"
          >
            Prev
          </button>
          <button
            type="button"
            disabled={page >= lastPage}
            onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
            className="h-6 px-2 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

export interface DatasetsPageProps {
  projectId: string;
}

export function DatasetsPage({ projectId }: DatasetsPageProps) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const authUser = useAuth((s) => s.user);
  const versionsQ = useQuery({
    queryKey: ["datasets", projectId],
    queryFn: () => datasetsApi.list(projectId, { limit: 100 }),
  });
  const membersQ = useQuery({
    queryKey: ["members"],
    queryFn: () => membersApi.list(),
    enabled: !!authUser?.id,
    retry: false,
    staleTime: 60_000,
  });
  const myRole: Role | null = useMemo(() => {
    if (!authUser) return null;
    if (authUser.role === "admin") return "admin";
    const me = membersQ.data?.find((m) => m.id === authUser.id);
    return me?.role ?? authUser.role;
  }, [authUser, membersQ.data]);
  const canRollback = myRole === "admin";

  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [secondaryId, setSecondaryId] = useState<string | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);

  const items = versionsQ.data?.items ?? [];
  const primary = items.find((r) => r.id === primaryId) ?? null;
  const secondary = items.find((r) => r.id === secondaryId) ?? null;
  const canCompare = primary !== null && secondary !== null;

  const rollback = useMutation({
    mutationFn: ({ versionId, taskId }: { versionId: string; taskId: string }) =>
      datasetsApi.rollback(projectId, versionId, taskId),
    onSuccess: (res) => {
      showToast(
        `Rolled back. Replaced ${res.replaced_count} → restored ${res.restored_count}.`,
        { variant: "success" },
      );
      qc.invalidateQueries({ queryKey: ["datasets", projectId] });
      qc.invalidateQueries({ queryKey: ["project-stats", projectId] });
    },
    onError: () => {
      showToast("Rollback failed.", { variant: "error" });
    },
  });

  const handleRowClick = (row: DatasetVersionRow, e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      setSecondaryId((prev) => (prev === row.id ? null : row.id));
      return;
    }
    setPrimaryId((prev) => (prev === row.id ? null : row.id));
  };

  const askRollback = async (row: DatasetVersionRow) => {
    const n = summaryNumbers(row);
    const ok = await confirm({
      title: "Rollback to this dataset?",
      description: (
        <span>
          This will replace the current task annotations with{" "}
          <span className="font-medium text-[color:var(--text-primary)]">
            {n.annotations}
          </span>{" "}
          from{" "}
          <span className="font-medium text-[color:var(--text-primary)]">
            {row.label}
          </span>
          . A pre-state snapshot is recorded so the rollback itself is
          reversible.
        </span>
      ),
      confirmLabel: "Rollback",
      variant: "danger",
    });
    if (ok) rollback.mutate({ versionId: row.id, taskId: row.task_id });
  };

  return (
    <section className="grid gap-4" data-testid="datasets-page">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div className="grid gap-0.5">
          <h2 className="text-[14px] font-medium tracking-tight text-[color:var(--text-primary)]">
            Datasets
          </h2>
          <p className="text-[11.5px] text-[color:var(--text-tertiary)]">
            Versioned snapshots of each task's dataset bundle. Cmd-click a
            second row to compare.
          </p>
        </div>
        <button
          type="button"
          data-testid="datasets-compare-button"
          disabled={!canCompare}
          onClick={() => setCompareOpen(true)}
          className={cn(
            // DESIGN.md §4 — primary CTA carries the full PS hover signature
            // (cyan fill + 2px white border + 2px PS-blue ring + 1.05× lift,
            // 180ms ease).
            "h-8 px-3 rounded-[var(--radius-pill)] text-[12.5px] font-medium",
            "bg-[var(--accent)] text-[color:var(--accent-fg)]",
            "border border-[var(--accent)]",
            "transition-all duration-[180ms] ease-out",
            "hover:bg-[var(--accent-hover)] hover:border-white",
            "hover:shadow-[0_0_0_2px_var(--accent)] hover:scale-[1.05]",
            "active:opacity-60 active:scale-100",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "disabled:hover:scale-100 disabled:hover:border-[var(--accent)] disabled:hover:bg-[var(--accent)] disabled:hover:shadow-none",
          )}
        >
          Compare
        </button>
      </header>

      {versionsQ.isLoading && (
        <div
          data-testid="datasets-loading-skeleton"
          className="grid gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] p-2"
        >
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={cn(
                "h-10 rounded-[var(--radius-sm)]",
                "bg-[var(--bg-subtle)] animate-pulse",
              )}
            />
          ))}
        </div>
      )}
      {versionsQ.isError && (
        <p className="text-[12.5px] text-[color:var(--danger)]">
          Failed to load datasets.
        </p>
      )}
      {!versionsQ.isLoading && items.length === 0 && (
        <EmptyState
          testId="datasets-empty"
          variant="compact"
          icon={<Database className="h-5 w-5" />}
          title="No dataset versions yet"
          description="They accrue automatically with each retrain or export, and any time you take a manual snapshot."
        />
      )}

      {items.length > 0 && (
        <ul
          data-testid="datasets-list"
          className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] overflow-hidden"
        >
          {items.map((row) => {
            const n = summaryNumbers(row);
            const isPrimary = primaryId === row.id;
            const isSecondary = secondaryId === row.id;
            return (
              <li
                key={row.id}
                data-testid={`datasets-row-${row.id}`}
                data-selected={isPrimary || isSecondary ? "true" : undefined}
                className={cn(
                  "grid grid-cols-[1fr_auto] gap-2 items-center px-3 py-2",
                  "border-b border-[var(--border-subtle)] last:border-b-0",
                  "hover:bg-[var(--bg-hover)] transition-colors cursor-pointer",
                  (isPrimary || isSecondary) && "bg-[var(--bg-subtle)]",
                )}
                onClick={(e) => handleRowClick(row, e)}
              >
                <div className="grid gap-1 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <KindChip kind={row.kind} />
                    <span
                      className="text-[12.5px] truncate text-[color:var(--text-primary)]"
                      title={row.label}
                    >
                      {row.label}
                    </span>
                    {isPrimary && <Badge variant="ghost">A</Badge>}
                    {isSecondary && <Badge variant="ghost">B</Badge>}
                  </div>
                  <div className="flex flex-wrap gap-3 text-[10.5px] font-mono text-[color:var(--text-tertiary)]">
                    <span>{formatRelative(row.created_at)}</span>
                    <span data-testid={`datasets-row-task-${row.id}`}>
                      task {row.task_id.slice(0, 8)}
                    </span>
                    <span>annotations: {n.annotations}</span>
                    <span>accepted: {n.accepted}</span>
                    <span>rejected: {n.rejected}</span>
                  </div>
                </div>
                {canRollback && (
                  <button
                    type="button"
                    data-testid={`datasets-rollback-${row.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      askRollback(row);
                    }}
                    disabled={rollback.isPending}
                    className={cn(
                      "h-7 px-2.5 rounded-[var(--radius-6)] text-[11.5px]",
                      "border border-[var(--border-subtle)] text-[color:var(--text-secondary)]",
                      "transition-colors duration-[180ms] ease-out",
                      "hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
                      "disabled:opacity-50 disabled:cursor-not-allowed",
                    )}
                  >
                    Rollback
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <CompareDialog
        open={compareOpen}
        onOpenChange={setCompareOpen}
        projectId={projectId}
        a={primary}
        b={secondary}
      />
    </section>
  );
}
