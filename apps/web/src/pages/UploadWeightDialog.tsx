import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { weightsApi, type UploadWeightInput, type Weight } from "@/api/phase2";
import { projectsApi, type Project } from "@/api/projects";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/cn";

const TASK_KINDS: UploadWeightInput["task_kind"][] = [
  "detect",
  "segment",
  "classify",
  "pose",
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional default project id (e.g. when launched from a project page). */
  defaultProjectId?: string;
}

/**
 * Upload-a-YOLO-weight dialog. Backend endpoint:
 *   POST /projects/{project_id}/weights (multipart)
 *
 * v1 keeps `class_names` empty so the backend can auto-detect from the file.
 * See /tmp/v21-audit.md bug 4 — the table view existed but had no upload UI.
 */
export function UploadWeightDialog({ open, onOpenChange, defaultProjectId }: Props) {
  const qc = useQueryClient();

  const projectsQ = useQuery({ queryKey: ["projects"], queryFn: projectsApi.list });
  const projects = projectsQ.data ?? [];

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [taskKind, setTaskKind] =
    useState<UploadWeightInput["task_kind"]>("detect");
  const [projectId, setProjectId] = useState<string>(defaultProjectId ?? "");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const uploadM = useMutation<
    Weight,
    Error,
    { projectId: string; input: UploadWeightInput }
  >({
    mutationFn: ({ projectId: pid, input }) => weightsApi.upload(pid, input),
    onSuccess: () => {
      showToast("Weight uploaded", { variant: "success" });
      qc.invalidateQueries({ queryKey: ["weights"] });
      qc.invalidateQueries({ queryKey: ["weights", "workspace"] });
      reset();
      onOpenChange(false);
    },
    onError: (err) => {
      setErrorMsg(err?.message ?? "Upload failed");
    },
  });

  function reset() {
    setFile(null);
    setName("");
    setTaskKind("detect");
    setProjectId(defaultProjectId ?? "");
    setErrorMsg(null);
  }

  const effectiveProjectId = projectId || defaultProjectId || projects[0]?.id || "";
  const canSubmit =
    !!file && name.trim().length > 0 && !!effectiveProjectId && !uploadM.isPending;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!file || !effectiveProjectId) return;
    setErrorMsg(null);
    uploadM.mutate({
      projectId: effectiveProjectId,
      input: {
        name: name.trim(),
        task_kind: taskKind,
        class_names: [],
        file,
      },
    });
  }

  if (!open) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload YOLO weight</DialogTitle>
          <DialogDescription>
            Upload a custom <code className="font-mono text-[12px]">.pt</code> file
            for inference. Class names are auto-detected from the model.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-3" data-testid="upload-weight-form">
          <label className="grid gap-1.5">
            <span className="text-[12px] tracking-tight text-[color:var(--text-secondary)] font-medium">
              Weight file (.pt)
            </span>
            <input
              type="file"
              accept=".pt,application/octet-stream"
              aria-label="Weight file"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                if (f && !name) {
                  // Pre-fill name from the file basename.
                  setName(f.name.replace(/\.pt$/i, ""));
                }
              }}
              className={cn(
                "block w-full rounded-[var(--radius-sm)] border border-[var(--border-subtle)]",
                "bg-[var(--bg-elev)] px-2 py-1.5 text-[13px]",
                "file:mr-3 file:rounded file:border-0 file:bg-[var(--bg-subtle)] file:px-2 file:py-1 file:text-[12px]",
              )}
            />
          </label>

          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. yolov8n_traffic"
            required
          />

          <label className="grid gap-1.5">
            <span className="text-[12px] tracking-tight text-[color:var(--text-secondary)] font-medium">
              Task kind
            </span>
            <select
              aria-label="Task kind"
              value={taskKind}
              onChange={(e) =>
                setTaskKind(e.target.value as UploadWeightInput["task_kind"])
              }
              className={cn(
                "h-9 px-2 rounded-[var(--radius-sm)]",
                "bg-[var(--bg-elev)] border border-[var(--border-subtle)]",
                "text-[13px] tracking-tight",
                "focus:outline-none focus:border-[var(--accent)]",
              )}
            >
              {TASK_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-1.5">
            <span className="text-[12px] tracking-tight text-[color:var(--text-secondary)] font-medium">
              Project
            </span>
            <select
              aria-label="Project"
              value={effectiveProjectId}
              onChange={(e) => setProjectId(e.target.value)}
              className={cn(
                "h-9 px-2 rounded-[var(--radius-sm)]",
                "bg-[var(--bg-elev)] border border-[var(--border-subtle)]",
                "text-[13px] tracking-tight",
                "focus:outline-none focus:border-[var(--accent)]",
              )}
            >
              {projects.length === 0 && <option value="">No projects yet</option>}
              {projects.map((p: Project) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          {errorMsg && (
            <p
              className="text-[12.5px] text-[color:var(--danger)]"
              data-testid="upload-error"
            >
              {errorMsg}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={uploadM.isPending}
              disabled={!canSubmit}
              leftIcon={!uploadM.isPending && <Upload className="h-4 w-4" />}
            >
              Upload
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
