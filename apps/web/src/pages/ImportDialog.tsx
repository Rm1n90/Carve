// Armin Mehri — mehri.armin@gmail.com
//
// Plan-20.5 — Two-step import: (1) drop file(s), (2) review the
// validation report and decide whether to commit.
//
// YOLO accepts loose ``.txt`` files (multi-select), or a ZIP, or a
// ``.txt`` set + an optional ``data.yaml``/``classes.txt``/``names.txt``.
// COCO accepts a single ``.json`` (or a ``.zip`` carrying it).
//
// On drop the dialog runs a server-side dryrun and shows what *would*
// be imported and what would be skipped (and why). The user clicks
// Continue to commit, or Cancel to abandon.
import { useEffect, useMemo, useState } from "react";
import { useDropzone, type Accept } from "react-dropzone";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileArchive, Info, X } from "lucide-react";
import {
  importsApi,
  type DryrunResponse,
  type ImportFormat,
  type ImportProgress,
  type ImportReport,
} from "@/api/imports";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/cn";

interface Props {
  taskId: string;
}

const YOLO_ACCEPT: Accept = {
  "application/zip": [".zip"],
  "text/plain": [".txt"],
  "application/x-yaml": [".yaml", ".yml"],
  "text/yaml": [".yaml", ".yml"],
};

const COCO_ACCEPT: Accept = {
  "application/zip": [".zip"],
  "application/json": [".json"],
};

function formatErrorDetail(err: unknown): string {
  const data = (err as { response?: { data?: { detail?: string; error?: string } } })
    ?.response?.data;
  return data?.detail ?? data?.error ?? "import_failed";
}

export function ImportDialog({ taskId }: Props) {
  const qc = useQueryClient();
  const [format, setFormat] = useState<ImportFormat>("yolo");
  const [stagedImportId, setStagedImportId] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [committedImportId, setCommittedImportId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Plan-20.5 — Dropping files starts the dryrun. The server stages the
  // bytes in MinIO and returns a report; nothing is written to the DB
  // yet. The user reviews and commits.
  const dryrun = useMutation({
    mutationFn: async (files: File[]) => {
      setError(null);
      setReport(null);
      setStagedImportId(null);
      setCommittedImportId(null);
      return importsApi.createDryrun(taskId, files, format);
    },
    onSuccess: (res: DryrunResponse) => {
      setStagedImportId(res.import_id);
      setReport(res.report);
    },
    onError: (err) => setError(formatErrorDetail(err)),
  });

  const commit = useMutation({
    mutationFn: async (importId: string) => importsApi.confirm(taskId, importId),
    onSuccess: (res) => setCommittedImportId(res.import_id),
    onError: (err) => setError(formatErrorDetail(err)),
  });

  const progressQ = useQuery<ImportProgress>({
    queryKey: ["import", taskId, committedImportId],
    queryFn: () => importsApi.get(taskId, committedImportId!),
    enabled: !!committedImportId,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      if (!s) return 1000;
      return s === "failed" || s.startsWith("completed") ? false : 1000;
    },
  });

  const status = progressQ.data?.status;
  useEffect(() => {
    if (status && status.startsWith("completed")) {
      qc.invalidateQueries({ queryKey: ["annotations", taskId] });
    }
  }, [status, qc, taskId]);

  const accept = format === "yolo" ? YOLO_ACCEPT : COCO_ACCEPT;
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept,
    multiple: format === "yolo",
    onDrop: (files) => {
      if (files.length > 0) dryrun.mutate(files);
    },
  });

  const reset = () => {
    setStagedImportId(null);
    setReport(null);
    setCommittedImportId(null);
    setError(null);
  };

  return (
    <section className="grid gap-3">
      <h2 className="text-[18px] font-medium tracking-tight text-primary">Import annotations</h2>

      {!stagedImportId && !committedImportId && (
        <>
          <div className="flex items-center gap-3 text-[13px] text-secondary">
            <span className="font-medium tracking-tight">Format:</span>
            <Select value={format} onValueChange={(v) => setFormat(v as ImportFormat)}>
              <Select.Trigger aria-label="import-format" data-testid="import-format">
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="yolo" data-testid="import-format-yolo">
                  YOLO
                </Select.Item>
                <Select.Item value="coco" data-testid="import-format-coco">
                  COCO
                </Select.Item>
              </Select.Content>
            </Select>
          </div>
          <div
            {...getRootProps()}
            className={cn(
              "grid place-items-center gap-2 px-6 py-10 cursor-pointer transition-all",
              "rounded-[var(--radius-lg)] border-2 border-dashed",
              isDragActive
                ? "border-[var(--border-accent)] bg-[var(--accent-bg)]"
                : "border-[var(--border-subtle)] bg-[oklch(0.18_0.012_240_/_0.30)] hover:border-[var(--border-strong)]",
            )}
          >
            <input {...getInputProps()} aria-label="import-input" data-testid="import-input" />
            <FileArchive
              className={cn(
                "h-7 w-7 transition-colors",
                isDragActive ? "text-[color:var(--accent)]" : "text-tertiary",
              )}
            />
            <p className="text-[13px] text-secondary tracking-tight text-center">
              {isDragActive
                ? "Drop to validate"
                : format === "yolo"
                  ? "Drop YOLO label files (.txt) — or a .zip / data.yaml. Multi-select supported."
                  : "Drop a COCO .json or .zip"}
            </p>
            {dryrun.isPending && (
              <p className="text-[11.5px] text-tertiary mt-2">Validating…</p>
            )}
          </div>
          <p className="text-[11.5px] text-tertiary leading-snug">
            We'll check every file before importing. Files that don't match an asset
            (or rows that reference unknown classes) are listed and skipped — they
            never affect the rest of the upload.
          </p>
        </>
      )}

      {stagedImportId && report && !committedImportId && (
        <ImportPreview
          report={report}
          format={format}
          onCancel={reset}
          onConfirm={() => commit.mutate(stagedImportId)}
          confirming={commit.isPending}
        />
      )}

      {committedImportId && progressQ.data && (
        <ImportProgressView progress={progressQ.data} onClose={reset} />
      )}

      {error && (
        <p
          role="alert"
          data-testid="import-error"
          className="text-[color:var(--danger)] text-[13px] flex items-start gap-2"
        >
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </section>
  );
}

interface ImportPreviewProps {
  report: ImportReport;
  format: ImportFormat;
  onCancel: () => void;
  onConfirm: () => void;
  confirming: boolean;
}

function ImportPreview({
  report,
  format,
  onCancel,
  onConfirm,
  confirming,
}: ImportPreviewProps) {
  const skipped = report.total_parsed - report.importable;
  const hasIssues =
    report.unmatched_files.length > 0 ||
    report.unknown_classes.length > 0 ||
    report.parse_warnings.length > 0;
  const hasNothingImportable = report.importable === 0;
  const kindLines = useMemo(() => {
    return Object.entries(report.by_kind)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`)
      .join(", ");
  }, [report.by_kind]);

  return (
    <div data-testid="import-preview" className="grid gap-3">
      <div
        className={cn(
          "rounded-[var(--radius-md)] border px-3 py-2.5 grid gap-1",
          hasNothingImportable
            ? "border-[color:var(--danger)] bg-[color-mix(in_oklch,var(--danger)_10%,transparent)]"
            : hasIssues
              ? "border-[color:var(--warning)] bg-[color-mix(in_oklch,var(--warning)_10%,transparent)]"
              : "border-[color:var(--success)] bg-[color-mix(in_oklch,var(--success)_10%,transparent)]",
        )}
      >
        <div className="flex items-center gap-2 text-[13px] font-medium text-primary">
          {hasNothingImportable ? (
            <AlertTriangle className="h-4 w-4 text-[color:var(--danger)]" />
          ) : hasIssues ? (
            <AlertTriangle className="h-4 w-4 text-[color:var(--warning)]" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-[color:var(--success)]" />
          )}
          {hasNothingImportable
            ? "Nothing to import"
            : `Ready to import ${report.importable} annotation${report.importable === 1 ? "" : "s"}`}
        </div>
        <p className="text-[11.5px] text-secondary leading-snug">
          {report.total_parsed.toLocaleString()} rows parsed
          {kindLines ? ` (${kindLines})` : ""}
          {skipped > 0 && `, ${skipped.toLocaleString()} skipped`}.
          {report.matched_files.length > 0 &&
            ` Will write to ${report.matched_files.length} asset${report.matched_files.length === 1 ? "" : "s"}.`}
        </p>
      </div>

      {report.unmatched_files.length > 0 && (
        <ReportSection
          title="Files with no matching asset (skipped)"
          tone="warning"
          items={report.unmatched_files.map(
            (e) => `${e.file} — ${e.rows} row${e.rows === 1 ? "" : "s"}`,
          )}
        />
      )}

      {report.unknown_classes.length > 0 && (
        <ReportSection
          title={
            format === "yolo"
              ? "Class indices that don't map to any project class (skipped)"
              : "Categories not in this project (skipped)"
          }
          tone="warning"
          items={report.unknown_classes.map(
            (e) => `${e.class} — ${e.rows} row${e.rows === 1 ? "" : "s"}`,
          )}
        />
      )}

      {report.parse_warnings.length > 0 && (
        <ReportSection
          title="Parser notes"
          tone="info"
          items={report.parse_warnings}
        />
      )}

      {report.class_names_resolved.length > 0 && format === "yolo" && (
        <p className="text-[11px] text-tertiary leading-snug">
          Class indices were resolved against{" "}
          <span className="font-mono">
            [{report.class_names_resolved.slice(0, 6).join(", ")}
            {report.class_names_resolved.length > 6
              ? `, +${report.class_names_resolved.length - 6} more`
              : ""}
            ]
          </span>
        </p>
      )}

      <div className="flex items-center gap-2 mt-1">
        <Button
          variant="primary"
          onClick={onConfirm}
          loading={confirming}
          disabled={hasNothingImportable}
          data-testid="import-confirm"
        >
          Continue & import {report.importable.toLocaleString()}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={confirming} data-testid="import-cancel">
          Cancel
        </Button>
      </div>
    </div>
  );
}

interface ReportSectionProps {
  title: string;
  tone: "warning" | "info";
  items: string[];
}

function ReportSection({ title, tone, items }: ReportSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, 6);
  return (
    <div
      className={cn(
        "rounded-[var(--radius-sm)] border px-3 py-2 grid gap-1",
        tone === "warning"
          ? "border-[color:var(--warning)]/50 bg-[var(--bg-sunken)]"
          : "border-[var(--border-subtle)] bg-[var(--bg-sunken)]",
      )}
    >
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-primary">
        {tone === "warning" ? (
          <AlertTriangle className="h-3.5 w-3.5 text-[color:var(--warning)]" />
        ) : (
          <Info className="h-3.5 w-3.5 text-tertiary" />
        )}
        {title} ({items.length})
      </div>
      <ul className="text-[11.5px] text-secondary list-disc pl-5 grid gap-0.5">
        {visible.map((it, i) => (
          <li key={i} className="truncate" title={it}>
            {it}
          </li>
        ))}
      </ul>
      {items.length > 6 && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="text-[11px] text-[color:var(--accent)] hover:underline self-start"
        >
          {expanded ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}

interface ImportProgressViewProps {
  progress: ImportProgress;
  onClose: () => void;
}

function ImportProgressView({ progress, onClose }: ImportProgressViewProps) {
  const pct =
    progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : null;
  const isDone = progress.status.startsWith("completed");
  const isFailed = progress.status === "failed";
  return (
    <div data-testid="import-progress" className="grid gap-2">
      <div className="flex items-center gap-2 text-[13px] text-primary">
        {isDone ? (
          <CheckCircle2 className="h-4 w-4 text-[color:var(--success)]" />
        ) : isFailed ? (
          <AlertTriangle className="h-4 w-4 text-[color:var(--danger)]" />
        ) : (
          <Info className="h-4 w-4 text-[color:var(--accent)]" />
        )}
        {isDone
          ? `Imported ${progress.done.toLocaleString()} annotations`
          : isFailed
            ? "Import failed"
            : `Importing… ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}`}
      </div>
      <div className="h-1.5 rounded-full bg-[var(--bg-sunken)] overflow-hidden">
        <div
          className={cn(
            "h-full transition-[width] duration-200",
            isFailed ? "bg-[color:var(--danger)]" : "bg-[color:var(--accent)]",
          )}
          style={{ width: pct === null ? "30%" : `${pct}%` }}
        />
      </div>
      {progress.warnings.length > 0 && (
        <ReportSection title="Warnings" tone="warning" items={progress.warnings} />
      )}
      {(isDone || isFailed) && (
        <Button variant="ghost" onClick={onClose} leftIcon={<X className="h-3.5 w-3.5" />}>
          Close
        </Button>
      )}
    </div>
  );
}
