import { useEffect, useState } from "react";
import { useDropzone, type Accept } from "react-dropzone";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileArchive } from "lucide-react";
import { importsApi, type ImportFormat, type ImportProgress } from "@/api/imports";
import { cn } from "@/lib/cn";

interface Props {
  taskId: string;
}

const YOLO_ACCEPT: Accept = {
  "application/zip": [".zip"],
};

const COCO_ACCEPT: Accept = {
  "application/zip": [".zip"],
  "application/json": [".json"],
};

export function ImportDialog({ taskId }: Props) {
  const qc = useQueryClient();
  const [format, setFormat] = useState<ImportFormat>("yolo");
  const [importId, setImportId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: async (file: File) => {
      setError(null);
      setImportId(null);
      return importsApi.create(taskId, file, format);
    },
    onSuccess: (res) => setImportId(res.import_id),
    onError: (err: unknown) => {
      const code =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        "import_failed";
      setError(code);
    },
  });

  const progressQ = useQuery<ImportProgress>({
    queryKey: ["import", taskId, importId],
    queryFn: () => importsApi.get(taskId, importId!),
    enabled: !!importId,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      if (!s) return 1000;
      return s === "failed" || s.startsWith("completed") ? false : 1000;
    },
    refetchIntervalInBackground: true,
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
    multiple: false,
    onDrop: (files) => {
      if (files[0]) create.mutate(files[0]);
    },
  });

  const done = progressQ.data?.done ?? 0;
  const total = progressQ.data?.total ?? 0;
  const warnings = progressQ.data?.warnings ?? [];

  return (
    <section className="grid gap-3">
      <h2 className="text-[18px] font-medium tracking-tight text-primary">Import annotations</h2>
      <label className="flex items-center gap-3 text-[13px] text-secondary">
        <span className="font-medium tracking-tight">Format:</span>
        <select
          aria-label="import-format"
          value={format}
          onChange={(e) => setFormat(e.target.value as ImportFormat)}
          className="h-9 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 text-[13px] text-primary focus:outline-none focus:border-[var(--accent)]"
        >
          <option value="yolo">YOLO</option>
          <option value="coco">COCO</option>
        </select>
      </label>
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
        <input {...getInputProps()} aria-label="import-input" />
        <FileArchive
          className={cn(
            "h-7 w-7 transition-colors",
            isDragActive ? "text-[var(--accent)]" : "text-tertiary",
          )}
        />
        <p className="text-[13px] text-secondary tracking-tight text-center">
          {isDragActive
            ? "Drop to import"
            : format === "yolo"
              ? "Drop a YOLO .zip — or click to choose"
              : "Drop a COCO .zip or .json — or click to choose"}
        </p>
      </div>
      {importId && (
        <p className="font-mono-data text-[12px] text-tertiary">
          {status ?? "pending"} · {done}/{total}
        </p>
      )}
      {status && status.startsWith("completed") && (
        <p className="text-[var(--success)] text-[13px]">Done.</p>
      )}
      {status === "failed" && (
        <p role="alert" className="text-[var(--danger)] text-[13px]">
          Import failed.
        </p>
      )}
      {warnings.length > 0 && (
        <ul className="grid gap-1 text-[var(--warning)] text-[12px] pl-5 list-disc">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-[var(--danger)] text-[13px]">
          {error}
        </p>
      )}
    </section>
  );
}
