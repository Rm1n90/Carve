import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { classesApi, type ClassRow } from "@/api/classes";
import {
  exportsApi,
  type ClassRemap,
  type ExportFormat,
  type ExportProgress,
  type ExportRequest,
  type ExportSplits,
} from "@/api/exports";

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
  const classesQ = useQuery<ClassRow[]>({
    queryKey: ["classes", projectId],
    queryFn: () => classesApi.listForProject(projectId),
  });

  const [format, setFormat] = useState<ExportFormat>("yolo");
  const [splits, setSplits] = useState<ExportSplits>(DEFAULT_SPLITS);
  const [includeImages, setIncludeImages] = useState<boolean>(true);
  const [remap, setRemap] = useState<RemapState>({});
  const [exportId, setExportId] = useState<string | null>(null);

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

  const updateRow = (classId: string, patch: Partial<RemapRow>) => {
    setRemap((p) => ({ ...p, [classId]: { ...p[classId], ...patch } }));
  };

  const handleExport = () => {
    const body: ExportRequest = {
      format,
      class_remap: buildPayload(remap),
      splits,
      include_images: includeImages,
    };
    create.mutate(body);
  };

  const inputBox: React.CSSProperties = {
    padding: "4px 6px",
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 4,
    color: "inherit",
  };

  return (
    <section style={{ display: "grid", gap: 10 }}>
      <h2 style={{ margin: 0 }}>Export annotations</h2>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
          Format:
          <select
            aria-label="export-format"
            value={format}
            onChange={(e) => setFormat(e.target.value as ExportFormat)}
            style={inputBox}
          >
            <option value="yolo">YOLO</option>
            <option value="coco">COCO</option>
          </select>
        </label>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
          <input
            type="checkbox"
            checked={includeImages}
            onChange={(e) => setIncludeImages(e.target.checked)}
            aria-label="include-images"
          />
          Include images
        </label>
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 13 }}>
        <span>Splits:</span>
        {(["train", "val", "test"] as const).map((k) => (
          <label key={k} style={{ display: "flex", gap: 4, alignItems: "center" }}>
            {k}
            <input
              type="number"
              step="0.1"
              min={0}
              max={1}
              value={splits[k]}
              onChange={(e) =>
                setSplits((p) => ({ ...p, [k]: Number(e.target.value) }))
              }
              aria-label={`split-${k}`}
              style={{ ...inputBox, width: 70 }}
            />
          </label>
        ))}
        <span style={{ opacity: sumValid ? 0.6 : 1, color: sumValid ? undefined : "rgb(240, 200, 120)" }}>
          Sum: {splitSum.toFixed(2)}
          {!sumValid && " — should be 1.0"}
        </span>
      </div>

      {classesQ.isLoading && <p style={{ opacity: 0.6, fontSize: 13, margin: 0 }}>Loading classes…</p>}

      {sortedClasses.length > 0 && (
        <table style={{ borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", opacity: 0.7 }}>
              <th style={{ padding: "4px 8px" }}>Source</th>
              <th style={{ padding: "4px 8px" }}>Export id</th>
              <th style={{ padding: "4px 8px" }}>Export name</th>
              <th style={{ padding: "4px 8px" }}>Skip</th>
            </tr>
          </thead>
          <tbody>
            {sortedClasses.map((c) => {
              const row = remap[c.id] ?? { export_id: c.idx, name: c.name, skip: false };
              return (
                <tr key={c.id} style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                  <td style={{ padding: "4px 8px" }}>
                    <span style={{ opacity: 0.6, marginRight: 6 }}>{c.idx}</span>
                    {c.name}
                  </td>
                  <td style={{ padding: "4px 8px" }}>
                    <input
                      type="number"
                      value={row.export_id}
                      disabled={row.skip}
                      onChange={(e) =>
                        updateRow(c.id, { export_id: Number(e.target.value) })
                      }
                      aria-label={`export-id-${c.id}`}
                      style={{ ...inputBox, width: 70 }}
                    />
                  </td>
                  <td style={{ padding: "4px 8px" }}>
                    <input
                      type="text"
                      value={row.name}
                      disabled={row.skip}
                      onChange={(e) => updateRow(c.id, { name: e.target.value })}
                      aria-label={`export-name-${c.id}`}
                      style={{ ...inputBox, width: 140 }}
                    />
                  </td>
                  <td style={{ padding: "4px 8px" }}>
                    <input
                      type="checkbox"
                      checked={row.skip}
                      onChange={(e) => updateRow(c.id, { skip: e.target.checked })}
                      aria-label={`skip-${c.id}`}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div>
        <button
          type="button"
          onClick={handleExport}
          disabled={inFlight}
          style={{
            padding: "6px 14px",
            background: inFlight ? "rgba(255,255,255,0.05)" : "rgba(120,200,255,0.15)",
            border: "1px solid rgba(120,200,255,0.3)",
            borderRadius: 6,
            color: "inherit",
            cursor: inFlight ? "not-allowed" : "pointer",
          }}
        >
          Export
        </button>
      </div>

      {exportId && status && status !== "completed" && status !== "failed" && (
        <p style={{ opacity: 0.75, fontSize: 13, margin: 0 }}>{status}…</p>
      )}

      {status === "completed" && progressQ.data?.download_url && (
        <p style={{ margin: 0 }}>
          <a
            href={progressQ.data.download_url}
            download
            style={{ color: "rgb(120, 220, 160)" }}
          >
            Download
          </a>
        </p>
      )}

      {status === "failed" && (
        <p role="alert" style={{ color: "tomato", fontSize: 13, margin: 0 }}>
          {progressQ.data?.error ?? "Export failed."}
        </p>
      )}
    </section>
  );
}
