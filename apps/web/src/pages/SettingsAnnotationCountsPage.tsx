// Armin Mehri — mehri.armin@gmail.com
/**
 * Settings → Annotation counts (superadmin only): how many annotations
 * each person made, per project and task or per class, over a period.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { projectsApi } from "@/api/projects";
import { tasksApi } from "@/api/tasks";
import {
  reportsApi,
  type AnnotationCountRow,
  type AnnotationCountsFilter,
} from "@/api/reports";
import { SettingsLayout } from "@/pages/SettingsPages";

const SELECT =
  "h-9 max-w-[260px] rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] px-2.5 text-[13px] text-[color:var(--text-primary)]";

const PERIODS: { label: string; days?: number }[] = [
  { label: "All time" },
  { label: "Last 24 hours", days: 1 },
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
];

const n = (v: number) => v.toLocaleString();

interface PersonTotal {
  key: string;
  email: string;
  total: number;
  from_ai: number;
  images: number;
}

function byPerson(rows: AnnotationCountRow[]): PersonTotal[] {
  const out = new Map<string, PersonTotal>();
  for (const r of rows) {
    const key = r.user_id ?? "unknown";
    const p = out.get(key) ?? {
      key,
      email: r.email ?? "Unknown or removed account",
      total: 0,
      from_ai: 0,
      images: 0,
    };
    p.total += r.total;
    p.from_ai += r.from_ai;
    p.images += r.images;
    out.set(key, p);
  }
  return [...out.values()].sort((a, b) => b.total - a.total);
}

function csvCell(v: string | number | null): string {
  const s = v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(rows: AnnotationCountRow[], groupBy: "task" | "class") {
  const head = ["project", groupBy, "person", "annotations", "from_ai_runs", "drawn", "images"];
  const lines = rows.map((r) =>
    [
      r.project_name,
      groupBy === "task" ? r.task_name : r.class_name,
      r.email,
      r.total,
      r.from_ai,
      r.total - r.from_ai,
      r.images,
    ]
      .map(csvCell)
      .join(","),
  );
  const blob = new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `annotation-counts-by-${groupBy}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={`px-3 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-[color:var(--text-tertiary)] ${right ? "text-right" : "text-left"}`}
    >
      {children}
    </th>
  );
}

function Td({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <td className={`px-3 py-1.5 text-[13px] ${right ? "text-right tabular-nums" : ""}`}>
      {children}
    </td>
  );
}

export function SettingsAnnotationCountsPage() {
  const [projectId, setProjectId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [groupBy, setGroupBy] = useState<"task" | "class">("task");
  const [period, setPeriod] = useState(0);
  const projectsQ = useQuery({ queryKey: ["projects"], queryFn: projectsApi.list });
  const tasksQ = useQuery({
    queryKey: ["projects", projectId, "tasks", "report"],
    queryFn: () => tasksApi.listForProject(projectId, { includeArchived: true }),
    enabled: projectId !== "",
  });
  const filter: AnnotationCountsFilter = {
    group_by: groupBy,
    ...(projectId ? { project_id: projectId } : {}),
    ...(taskId ? { task_id: taskId } : {}),
    ...(PERIODS[period].days ? { days: PERIODS[period].days } : {}),
  };
  const q = useQuery({
    queryKey: ["reports", "annotations", filter],
    queryFn: () => reportsApi.annotations(filter),
    staleTime: 60_000,
  });
  const rows = q.data?.rows ?? [];
  const people = byPerson(rows);
  const detail = [...rows].sort(
    (a, b) =>
      a.project_name.localeCompare(b.project_name) ||
      (a.task_name ?? a.class_name ?? "").localeCompare(b.task_name ?? b.class_name ?? "") ||
      b.total - a.total,
  );

  return (
    <SettingsLayout>
      <Card variant="surface" radius="lg" className="p-6 grid gap-4">
        <div>
          <h2 className="text-[16px] font-semibold tracking-tight">Annotation counts</h2>
          <p className="text-[13px] text-[color:var(--text-secondary)] mt-1 max-w-[720px]">
            How many annotations each person made. An annotation counts for whoever created
            it; <em>from AI runs</em> are the ones an AI tool they ran made (they carry a model
            score), <em>drawn</em> are the rest, including SAM clicks. Editing someone else's
            annotation does not move it to you. Projects and tasks in the Trash are left out.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-[12px] text-[color:var(--text-secondary)]">
            Project
            <select
              aria-label="Project"
              className={SELECT}
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setTaskId("");
              }}
            >
              <option value="">All projects</option>
              {(projectsQ.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-[12px] text-[color:var(--text-secondary)]">
            Task
            <select
              aria-label="Task"
              className={SELECT}
              value={taskId}
              disabled={projectId === ""}
              onChange={(e) => setTaskId(e.target.value)}
            >
              <option value="">All tasks</option>
              {(tasksQ.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-[12px] text-[color:var(--text-secondary)]">
            Break down by
            <select
              aria-label="Break down by"
              className={SELECT}
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as "task" | "class")}
            >
              <option value="task">Task</option>
              <option value="class">Class</option>
            </select>
          </label>
          <label className="grid gap-1 text-[12px] text-[color:var(--text-secondary)]">
            Period
            <select
              aria-label="Period"
              className={SELECT}
              value={period}
              onChange={(e) => setPeriod(Number(e.target.value))}
            >
              {PERIODS.map((p, i) => (
                <option key={p.label} value={i}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="secondary"
            size="md"
            leftIcon={<Download className="h-4 w-4" />}
            disabled={rows.length === 0}
            onClick={() => downloadCsv(detail, groupBy)}
          >
            Download CSV
          </Button>
        </div>
      </Card>

      {q.isLoading ? (
        <p className="text-[13px] text-[color:var(--text-tertiary)]">
          Counting… (all projects can take a few seconds)
        </p>
      ) : q.isError ? (
        <p className="text-[13px] text-[color:var(--danger)]">Could not count the annotations.</p>
      ) : rows.length === 0 ? (
        <p className="text-[13px] text-[color:var(--text-tertiary)]">No annotations here.</p>
      ) : (
        <>
          <Card variant="surface" radius="lg" className="p-4 grid gap-2 overflow-x-auto">
            <h3 className="text-[14px] font-semibold tracking-tight px-3">By person</h3>
            <table className="w-full" data-testid="counts-by-person">
              <thead>
                <tr>
                  <Th>Person</Th>
                  <Th right>Annotations</Th>
                  <Th right>From AI runs</Th>
                  <Th right>Drawn</Th>
                  {groupBy === "task" && <Th right>Images</Th>}
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.key} className="border-t border-[var(--border-subtle)]">
                    <Td>{p.email}</Td>
                    <Td right>{n(p.total)}</Td>
                    <Td right>{n(p.from_ai)}</Td>
                    <Td right>{n(p.total - p.from_ai)}</Td>
                    {groupBy === "task" && <Td right>{n(p.images)}</Td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card variant="surface" radius="lg" className="p-4 grid gap-2 overflow-x-auto">
            <h3 className="text-[14px] font-semibold tracking-tight px-3">
              By {groupBy === "task" ? "task" : "class"} and person
            </h3>
            <table className="w-full" data-testid="counts-detail">
              <thead>
                <tr>
                  <Th>Project</Th>
                  <Th>{groupBy === "task" ? "Task" : "Class"}</Th>
                  <Th>Person</Th>
                  <Th right>Annotations</Th>
                  <Th right>From AI runs</Th>
                  <Th right>Drawn</Th>
                  <Th right>Images</Th>
                </tr>
              </thead>
              <tbody>
                {detail.map((r) => (
                  <tr
                    key={`${r.project_id}/${r.task_id ?? r.class_name}/${r.user_id}`}
                    className="border-t border-[var(--border-subtle)]"
                  >
                    <Td>{r.project_name}</Td>
                    <Td>{groupBy === "task" ? r.task_name : r.class_name}</Td>
                    <Td>{r.email ?? "Unknown or removed account"}</Td>
                    <Td right>{n(r.total)}</Td>
                    <Td right>{n(r.from_ai)}</Td>
                    <Td right>{n(r.total - r.from_ai)}</Td>
                    <Td right>{n(r.images)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </SettingsLayout>
  );
}
