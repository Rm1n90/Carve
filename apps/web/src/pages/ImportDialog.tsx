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
import { useEffect, useMemo, useRef, useState } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileArchive, Info, X } from "lucide-react";
import {
  importsApi,
  type DryrunResponse,
  type ImportFormat,
  type ImportProgress,
  type ImportReport,
} from "@/api/imports";
import { exportsApi } from "@/api/exports";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/cn";

// Plan-20.6 — map short server reason codes to a one-line, plain-
// English message + suggested fix. Anything unrecognised falls
// through to the raw code so power users can still see it.
const ERROR_MESSAGES: Record<string, string> = {
  no_files: "No file was attached.",
  import_too_large: "Files are too large (the limit is 10 GB total).",
  only_one_zip_supported: "Only one .zip file at a time.",
  only_one_json_supported: "Only one .json file at a time.",
  yolo_needs_zip_or_txt:
    "YOLO needs at least one .txt label file (or a .zip).",
  coco_needs_zip_or_json:
    "COCO needs a .json file (or a .zip containing one).",
  staged_import_not_found_or_expired:
    "Your staged upload expired (more than 24 h ago). Please re-upload the files.",
  staged_import_for_other_task:
    "That staged upload belongs to a different task — please re-upload here.",
  redis_unavailable:
    "The job queue is offline right now. Try again in a moment.",
  task_not_found: "This task no longer exists.",
  download_failed:
    "Couldn't read the staged file. Please re-upload and try again.",
  parse_failed:
    "We couldn't read your file as a valid YOLO/COCO archive. Make sure it's the format you selected.",
};

function friendlyMessage(reason: string | null | undefined): string {
  if (!reason) return "Import failed.";
  // Strip the inner detail after a colon so 'parse_failed: <stack>' still
  // hits the lookup. Both 'parse_failed' and 'parse_failed: ...' map to
  // the same friendly message.
  const head = reason.split(":")[0].trim();
  if (ERROR_MESSAGES[head]) return ERROR_MESSAGES[head];
  if (reason.startsWith("unsupported_file_extension")) {
    const f = reason.split(":").slice(1).join(":").trim();
    return f
      ? `Can't read this file type — ${f}. Use .txt / .yaml / .zip / .json.`
      : "Unsupported file type.";
  }
  if (reason.startsWith("unsupported_format")) {
    return "That export format isn't supported here.";
  }
  return reason;
}

interface SummaryCounts {
  created: number;
  skipped: number;
}

function parseSummaryReason(reason: string | null | undefined): SummaryCounts | null {
  if (!reason) return null;
  const m = reason.match(/created=(\d+)\s+skipped=(\d+)/);
  if (!m) return null;
  return { created: Number(m[1]), skipped: Number(m[2]) };
}

interface Props {
  taskId: string;
}

// Plan-20.7 — extension-based validation so files with non-standard
// MIME types (Windows ZIPs reporting 'application/x-zip-compressed',
// .yaml files dragged from some apps with empty MIME, etc.) still pass.
// The previous MIME-keyed accept silently rejected them and the user
// saw "Uploaded 0 files" before the dialog vanished.
const YOLO_EXTS = [".zip", ".txt", ".yaml", ".yml"];
const COCO_EXTS = [".zip", ".json"];

function validateForFormat(format: ImportFormat) {
  const allowed = format === "yolo" ? YOLO_EXTS : COCO_EXTS;
  return (file: File) => {
    const lower = file.name.toLowerCase();
    if (allowed.some((ext) => lower.endsWith(ext))) return null;
    return {
      code: "ext-not-allowed",
      message: `Unsupported file type — accepted for ${format.toUpperCase()}: ${allowed.join(", ")}`,
    };
  };
}

function formatErrorDetail(err: unknown): string {
  const data = (err as { response?: { data?: { detail?: string; error?: string } } })
    ?.response?.data;
  return friendlyMessage(data?.detail ?? data?.error ?? "import_failed");
}

export function ImportDialog({ taskId }: Props) {
  const qc = useQueryClient();
  const [format, setFormat] = useState<ImportFormat>("yolo");
  const [stagedImportId, setStagedImportId] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [committedImportId, setCommittedImportId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Plan-20.8 — when checked, the server deletes the task's existing
  // annotations before importing the new ones. Default is OFF so the
  // import is additive (matches what the user expected when they had
  // no idea that's what would happen).
  const [replaceExisting, setReplaceExisting] = useState(false);

  // Plan-20.8 — fetch the task's existing annotation tally so the
  // dialog can warn the user before they confirm. Same endpoint used
  // by the export YOLO chooser.
  const kindsQ = useQuery({
    queryKey: ["task-annotation-kinds", taskId],
    queryFn: () => exportsApi.kinds(taskId),
    staleTime: 30_000,
  });
  const existingTotal =
    (kindsQ.data?.bbox ?? 0) +
    (kindsQ.data?.polygon ?? 0) +
    (kindsQ.data?.mask ?? 0) +
    (kindsQ.data?.tag ?? 0);

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
    mutationFn: async (importId: string) =>
      importsApi.confirm(taskId, importId, replaceExisting),
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
  const reason = progressQ.data?.reason;
  // Plan-20.6 — fire a single toast on the terminal status so the user
  // gets a clear, persistent notification even if they've already
  // looked away from the dialog. The ref guards against the polling
  // query re-emitting the same terminal value across renders.
  const terminalToastedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!status || !committedImportId) return;
    if (terminalToastedRef.current === committedImportId) return;
    if (status.startsWith("completed")) {
      qc.invalidateQueries({ queryKey: ["annotations", taskId] });
      const summary = parseSummaryReason(reason);
      const msg = summary
        ? summary.skipped > 0
          ? `Imported ${summary.created.toLocaleString()} annotations · ${summary.skipped.toLocaleString()} skipped (see warnings).`
          : `Imported ${summary.created.toLocaleString()} annotations.`
        : "Import finished.";
      showToast(msg, {
        variant: status === "completed_with_warnings" ? "warning" : "success",
        duration: 5000,
      });
      terminalToastedRef.current = committedImportId;
    } else if (status === "failed") {
      showToast(`Import failed — ${friendlyMessage(reason)}`, {
        variant: "error",
        duration: 6000,
      });
      terminalToastedRef.current = committedImportId;
    }
  }, [status, reason, qc, taskId, committedImportId]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    validator: validateForFormat(format),
    multiple: format === "yolo",
    onDrop: (files) => {
      if (files.length === 0) return;
      dryrun.mutate(files);
    },
    onDropRejected: (rejections: FileRejection[]) => {
      const head = rejections[0];
      const detail =
        head?.errors[0]?.message ?? "Couldn't determine the rejection reason.";
      const msg =
        rejections.length === 1
          ? `Couldn't accept "${head.file.name}" — ${detail}`
          : `${rejections.length} files were rejected — ${detail}`;
      setError(msg);
      showToast(msg, { variant: "error", duration: 6000 });
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
          {/* Plan-20.8 — surface the task's existing annotation count up
              front so the user is never surprised. Additive by default;
              the checkbox lets them choose to wipe-and-replace. */}
          {existingTotal > 0 && (
            <div
              data-testid="import-existing-warning"
              className="rounded-[var(--radius-md)] border border-[color:var(--warning)] bg-[color-mix(in_oklch,var(--warning)_10%,transparent)] px-3 py-2.5 grid gap-2"
            >
              <div className="flex items-start gap-2 text-[12.5px] text-primary leading-snug">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-[color:var(--warning)]" />
                <div className="grid gap-0.5">
                  <span className="font-medium">
                    This task already has {existingTotal.toLocaleString()} annotation
                    {existingTotal === 1 ? "" : "s"}.
                  </span>
                  <span className="text-secondary text-[11.5px]">
                    By default, importing <strong>adds</strong> on top — your
                    existing annotations stay. Tick the box below to wipe them
                    first.
                  </span>
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer text-[12px] text-secondary pl-6">
                <input
                  type="checkbox"
                  checked={replaceExisting}
                  onChange={(e) => setReplaceExisting(e.target.checked)}
                  data-testid="import-replace-existing"
                  className="h-3.5 w-3.5 accent-[var(--danger)]"
                />
                <span>
                  Delete the {existingTotal.toLocaleString()} existing annotation
                  {existingTotal === 1 ? "" : "s"} first (irreversible).
                </span>
              </label>
            </div>
          )}
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
          replaceExisting={replaceExisting}
          existingTotal={existingTotal}
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
  replaceExisting: boolean;
  existingTotal: number;
  onCancel: () => void;
  onConfirm: () => void;
  confirming: boolean;
}

function ImportPreview({
  report,
  format,
  replaceExisting,
  existingTotal,
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

      {replaceExisting && existingTotal > 0 && (
        <p
          data-testid="import-preview-replace-note"
          className="text-[11.5px] leading-snug text-[color:var(--danger)]"
        >
          ⚠ The {existingTotal.toLocaleString()} existing annotation
          {existingTotal === 1 ? "" : "s"} will be deleted before this
          import runs.
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
          {replaceExisting && existingTotal > 0
            ? `Replace ${existingTotal.toLocaleString()} & import ${report.importable.toLocaleString()}`
            : `Continue & import ${report.importable.toLocaleString()}`}
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
  const summary = parseSummaryReason(progress.reason);
  // Plan-20.6 — clear, plain-English headline for every terminal
  // state so the user knows exactly what happened.
  let headline = `Importing… ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}`;
  if (isDone) {
    if (summary && summary.skipped > 0) {
      headline =
        `Imported ${summary.created.toLocaleString()} annotations · ` +
        `${summary.skipped.toLocaleString()} skipped (see warnings)`;
    } else if (summary) {
      headline = `Imported ${summary.created.toLocaleString()} annotations`;
    } else {
      headline = `Imported ${progress.done.toLocaleString()} annotations`;
    }
  } else if (isFailed) {
    headline = `Import failed — ${friendlyMessage(progress.reason)}`;
  }
  return (
    <div data-testid="import-progress" className="grid gap-2">
      <div className="flex items-start gap-2 text-[13px] text-primary leading-snug">
        {isDone ? (
          <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-[color:var(--success)]" />
        ) : isFailed ? (
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-[color:var(--danger)]" />
        ) : (
          <Info className="h-4 w-4 mt-0.5 shrink-0 text-[color:var(--accent)]" />
        )}
        <span>{headline}</span>
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
