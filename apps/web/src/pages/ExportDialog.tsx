import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Download, FileDown } from "lucide-react";
import { type ClassRow } from "@/api/classes";
import { tasksApi } from "@/api/tasks";
import {
  exportsApi,
  type ClassRemap,
  type ExportFormat,
  type ExportProgress,
  type ExportRequest,
  type ExportSplits,
} from "@/api/exports";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";

interface Props {
  projectId: string;
  taskId: string;
}

interface RemapRow {
  export_id: number;
  name: string;
  skip: boolean;
}

type RemapState = Record<string, RemapRow>;

const DEFAULT_SPLITS: ExportSplits = { train: 0.8, val: 0.1, test: 0.1 };
// v3.0 D12 — splits payload when the user picks "Single set (no split)".
// The backend already accepts this shape (apps/api/.../exports/job.py:78);
// this constant just makes the intent explicit on the wire.
const SINGLE_SET_SPLITS: ExportSplits = { train: 1.0, val: 0.0, test: 0.0 };

type SplitMode = "train-val-test" | "single";

function buildDefaultRemap(classes: ClassRow[]): RemapState {
  const out: RemapState = {};
  for (const c of classes) {
    out[c.id] = { export_id: c.idx, name: c.name, skip: false };
  }
  return out;
}

function buildPayload(remap: RemapState): ClassRemap {
  const out: ClassRemap = {};
  for (const [classId, row] of Object.entries(remap)) {
    out[classId] = row.skip ? null : { export_id: row.export_id, name: row.name };
  }
  return out;
}

export function ExportDialog({ projectId, taskId }: Props) {
  // v3.1 Issue 3 (Option A) — exports are task-scoped. Pull the
  // task-effective class list so the remap table only shows classes the
  // task is actually configured to use. When no subset is set the
  // backend returns the full project list, preserving the legacy view.
  const taskClassesQ = useQuery({
    queryKey: ["task-classes", projectId, taskId],
    queryFn: () => tasksApi.getClasses(projectId, taskId),
  });
  const classesQ = {
    data: taskClassesQ.data?.classes as ClassRow[] | undefined,
    isLoading: taskClassesQ.isLoading,
  };

  const [format, setFormat] = useState<ExportFormat>("yolo");
  const [splits, setSplits] = useState<ExportSplits>(DEFAULT_SPLITS);
  // v3.0 D12 — "single set" hides train/val/test inputs and ships
  // {train: 1, val: 0, test: 0}.
  // v3.1 Bug 4 — single-set is now the default. Users opt into the
  // 80/10/10 train/val/test flow explicitly.
  const [mode, setMode] = useState<SplitMode>("single");
  const [includeImages, setIncludeImages] = useState<boolean>(true);
  const [remap, setRemap] = useState<RemapState>({});
  const [exportId, setExportId] = useState<string | null>(null);
  // v3.0 B10 — class density: filter the remap table on long class lists.
  const [classFilter, setClassFilter] = useState<string>("");

  useEffect(() => {
    if (classesQ.data) {
      setRemap(buildDefaultRemap(classesQ.data));
    }
  }, [classesQ.data]);

  const create = useMutation({
    mutationFn: async (body: ExportRequest) => exportsApi.create(taskId, body),
    onSuccess: (res) => setExportId(res.export_id),
  });

  const progressQ = useQuery<ExportProgress>({
    queryKey: ["export", taskId, exportId],
    queryFn: () => exportsApi.get(taskId, exportId!),
    enabled: !!exportId,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "completed" || s === "failed" ? false : 1000;
    },
  });

  const status = progressQ.data?.status;
  const inFlight = status === "pending" || status === "running" || create.isPending;
  const splitSum = splits.train + splits.val + splits.test;
  const sumValid = Math.abs(splitSum - 1.0) <= 0.001;

  const sortedClasses = useMemo(() => {
    return (classesQ.data ?? []).slice().sort((a, b) => a.idx - b.idx);
  }, [classesQ.data]);

  // v3.0 B10 — sub-string match on class name, case-insensitive.
  const visibleClasses = useMemo(() => {
    const q = classFilter.trim().toLowerCase();
    if (!q) return sortedClasses;
    return sortedClasses.filter((c) => c.name.toLowerCase().includes(q));
  }, [sortedClasses, classFilter]);

  const updateRow = (classId: string, patch: Partial<RemapRow>) => {
    setRemap((p) => ({ ...p, [classId]: { ...p[classId], ...patch } }));
  };

  const handleExport = () => {
    const body: ExportRequest = {
      format,
      class_remap: buildPayload(remap),
      // v3.0 D12 — when "Single set" is selected we override the train/val/test
      // form values so the user's last-typed numbers don't leak into the
      // payload. Backend accepts {train: 1, val: 0, test: 0} as a no-split
      // export.
      splits: mode === "single" ? SINGLE_SET_SPLITS : splits,
      include_images: includeImages,
    };
    create.mutate(body);
  };

  const numInput =
    "h-8 w-[80px] rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 text-[12px] text-primary focus:outline-none focus:border-[var(--accent)] disabled:opacity-50 font-mono-data";
  const textInput =
    "h-8 w-[160px] rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 text-[12px] text-primary focus:outline-none focus:border-[var(--accent)] disabled:opacity-50";

  return (
    <section className="grid gap-4">
      <h2 className="text-[18px] font-medium tracking-tight text-primary">Export annotations</h2>

      <div className="flex flex-wrap items-center gap-4 text-[13px] text-secondary">
        <div className="flex items-center gap-2.5">
          <span className="font-medium tracking-tight">Format</span>
          <Select value={format} onValueChange={(v) => setFormat(v as ExportFormat)}>
            <Select.Trigger aria-label="export-format" data-testid="export-format">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="yolo" data-testid="export-format-yolo">
                YOLO
              </Select.Item>
              <Select.Item value="coco" data-testid="export-format-coco">
                COCO
              </Select.Item>
            </Select.Content>
          </Select>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={includeImages}
            onChange={(e) => setIncludeImages(e.target.checked)}
            aria-label="include-images"
            className="h-4 w-4 accent-[var(--accent)]"
          />
          Include images
        </label>
      </div>

      {/* v3.0 D12 — top-level mode toggle: ship a single set, or split into
          train/val/test. We use plain radios because there is no shared
          RadioGroup primitive yet; promoting one is intentionally deferred. */}
      <div
        role="radiogroup"
        aria-label="export-split-mode"
        className="flex flex-wrap items-center gap-4 text-[13px] text-secondary"
      >
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="radio"
            name="export-split-mode"
            value="train-val-test"
            checked={mode === "train-val-test"}
            onChange={() => setMode("train-val-test")}
            aria-label="split-mode-train-val-test"
            data-testid="export-split-mode-train-val-test"
            className="h-4 w-4 accent-[var(--accent)]"
          />
          Train / Val / Test split
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="radio"
            name="export-split-mode"
            value="single"
            checked={mode === "single"}
            onChange={() => setMode("single")}
            aria-label="split-mode-single"
            data-testid="export-split-mode-single"
            className="h-4 w-4 accent-[var(--accent)]"
          />
          Single set (no split)
        </label>
      </div>

      {mode === "train-val-test" && (
        <div
          data-testid="export-splits-row"
          className="flex flex-wrap items-center gap-3 text-[13px] text-secondary"
        >
          <span className="font-medium tracking-tight">Splits</span>
          {(["train", "val", "test"] as const).map((k) => (
            <label key={k} className="flex items-center gap-1.5">
              <span className="text-tertiary text-[11px] uppercase tracking-wide">{k}</span>
              <input
                type="number"
                step="0.1"
                min={0}
                max={1}
                value={splits[k]}
                onChange={(e) => setSplits((p) => ({ ...p, [k]: Number(e.target.value) }))}
                aria-label={`split-${k}`}
                className={numInput}
              />
            </label>
          ))}
          <span
            className={
              sumValid
                ? "font-mono-data text-[11px] text-tertiary"
                : "font-mono-data text-[11px] text-[color:var(--warning)]"
            }
          >
            Sum: {splitSum.toFixed(2)}
            {!sumValid && " — should be 1.0"}
          </span>
        </div>
      )}

      {classesQ.isLoading && (
        <p className="text-tertiary text-[13px]">Loading classes…</p>
      )}

      {sortedClasses.length > 0 && (
        <div className="grid gap-2">
          {/* v3.0 B10 — class density: filter input + count above the scroll host. */}
          <div className="flex items-center gap-3">
            <input
              type="search"
              placeholder="Filter classes…"
              value={classFilter}
              onChange={(e) => setClassFilter(e.target.value)}
              aria-label="filter-classes"
              data-testid="export-class-filter"
              className="h-8 flex-1 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2.5 text-[12px] text-primary placeholder:text-tertiary focus:outline-none focus:border-[var(--accent)]"
            />
            <span
              className="font-mono-data text-[11px] text-tertiary whitespace-nowrap"
              data-testid="export-class-count"
            >
              Showing {visibleClasses.length} of {sortedClasses.length} classes
            </span>
          </div>
          <div
            data-testid="export-class-table-scroll"
            className="max-h-[400px] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]"
          >
            <table className="w-full border-collapse text-[12px]">
              <thead className="sticky top-0 z-10 bg-[var(--bg-raised)]">
                <tr className="text-tertiary uppercase tracking-[0.08em]">
                  <th className="px-3 py-2 text-left font-medium">Source</th>
                  <th className="px-3 py-2 text-left font-medium">Export id</th>
                  <th className="px-3 py-2 text-left font-medium">Export name</th>
                  <th className="px-3 py-2 text-left font-medium">Skip</th>
                </tr>
              </thead>
              <tbody>
                {visibleClasses.length === 0 && (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-3 py-4 text-center text-tertiary italic"
                    >
                      No classes match “{classFilter}”.
                    </td>
                  </tr>
                )}
                {visibleClasses.map((c) => {
                  const row = remap[c.id] ?? { export_id: c.idx, name: c.name, skip: false };
                  return (
                    <tr key={c.id} className="border-t border-[var(--border-subtle)]">
                      <td className="px-3 py-2">
                        <span className="font-mono-data text-tertiary mr-2">{c.idx}</span>
                        <span className="text-primary tracking-tight">{c.name}</span>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          // v3.7 Issue 7: clamp to 0 so negative typing
                          // never produces a negative class id, which the
                          // exporter cannot serialise to YOLO/COCO formats.
                          min={0}
                          inputMode="numeric"
                          value={row.export_id}
                          disabled={row.skip}
                          onChange={(e) => {
                            const v = Math.max(0, Number(e.target.value) || 0);
                            updateRow(c.id, { export_id: v });
                          }}
                          aria-label={`export-id-${c.id}`}
                          className={numInput}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          value={row.name}
                          disabled={row.skip}
                          onChange={(e) => updateRow(c.id, { name: e.target.value })}
                          aria-label={`export-name-${c.id}`}
                          className={textInput}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={row.skip}
                          onChange={(e) => updateRow(c.id, { skip: e.target.checked })}
                          aria-label={`skip-${c.id}`}
                          className="h-4 w-4 accent-[var(--accent)]"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div>
        <Button
          type="button"
          variant="primary"
          onClick={handleExport}
          loading={inFlight}
          leftIcon={!inFlight && <FileDown className="h-4 w-4" />}
        >
          Export
        </Button>
      </div>

      {exportId && status && status !== "completed" && status !== "failed" && (
        <p className="font-mono-data text-[12px] text-tertiary">{status}…</p>
      )}

      {status === "completed" && progressQ.data?.download_url && (
        <p>
          <a
            href={progressQ.data.download_url}
            download
            className="inline-flex items-center gap-1.5 text-[color:var(--success)] hover:underline tracking-tight"
          >
            <Download className="h-4 w-4" />
            Download
          </a>
        </p>
      )}

      {status === "failed" && (
        <p role="alert" className="text-[color:var(--danger)] text-[13px]">
          {progressQ.data?.error ?? "Export failed."}
        </p>
      )}
    </section>
  );
}
