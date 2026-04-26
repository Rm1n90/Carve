import { useEffect, useState } from "react";
import { useDropzone, type Accept } from "react-dropzone";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { importsApi, type ImportFormat, type ImportProgress } from "@/api/imports";

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
      return s === "complete" || s === "failed" ? false : 1000;
    },
    refetchIntervalInBackground: true,
  });

  const status = progressQ.data?.status;
  useEffect(() => {
    if (status === "complete") {
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
    <section style={{ display: "grid", gap: 8 }}>
      <h2 style={{ margin: 0 }}>Import annotations</h2>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
        Format:
        <select
          aria-label="import-format"
          value={format}
          onChange={(e) => setFormat(e.target.value as ImportFormat)}
          style={{ padding: "4px 8px" }}
        >
          <option value="yolo">YOLO</option>
          <option value="coco">COCO</option>
        </select>
      </label>
      <div
        {...getRootProps()}
        style={{
          padding: 24,
          border: `2px dashed ${isDragActive ? "rgba(120, 200, 255, 0.6)" : "rgba(255,255,255,0.2)"}`,
          borderRadius: 10,
          textAlign: "center",
          cursor: "pointer",
          background: isDragActive ? "rgba(120,200,255,0.05)" : undefined,
        }}
      >
        <input {...getInputProps()} aria-label="import-input" />
        <p style={{ margin: 0 }}>
          {isDragActive
            ? "Drop to import"
            : format === "yolo"
              ? "Drop a YOLO .zip — or click to choose"
              : "Drop a COCO .zip or .json — or click to choose"}
        </p>
      </div>
      {importId && (
        <p style={{ opacity: 0.75, fontSize: 13, margin: 0 }}>
          {status ?? "pending"} · {done}/{total}
        </p>
      )}
      {status === "complete" && (
        <p style={{ color: "rgb(120, 220, 160)", fontSize: 13, margin: 0 }}>Done.</p>
      )}
      {status === "failed" && (
        <p role="alert" style={{ color: "tomato", fontSize: 13, margin: 0 }}>
          Import failed.
        </p>
      )}
      {warnings.length > 0 && (
        <ul style={{ color: "rgb(240, 200, 120)", fontSize: 13, margin: 0, paddingLeft: 20 }}>
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" style={{ color: "tomato", fontSize: 13, margin: 0 }}>
          {error}
        </p>
      )}
    </section>
  );
}
