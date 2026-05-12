// Armin Mehri — mehri.armin@gmail.com
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
import { Select } from "@/components/ui/Select";
import { weightsApi, type UploadWeightInput, type Weight } from "@/api/phase2";
import { projectsApi, type Project } from "@/api/projects";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { useConfirm } from "@/components/ui/ConfirmDialog";

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
 * v3.3 (audit issue 3a): the backend now delegates to the model service's
 * /yolo/inspect endpoint to extract `model.names` from the .pt itself, so
 * the dialog no longer needs to ask the user for the class table. We keep
 * the `class_names: []` submission for backwards-compatibility with older
 * api versions; the field is optional server-side as of v3.3.
 */
export function UploadWeightDialog({ open, onOpenChange, defaultProjectId }: Props) {
  const qc = useQueryClient();
  const confirm = useConfirm();

  const projectsQ = useQuery({ queryKey: ["projects"], queryFn: projectsApi.list });
  const projects = projectsQ.data ?? [];

  const existingWeightsQ = useQuery({
    queryKey: ["weights", "workspace"],
    queryFn: weightsApi.listWorkspace,
  });
  const existingWeights = existingWeightsQ.data ?? [];

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [taskKind, setTaskKind] =
    useState<UploadWeightInput["task_kind"]>("detect");
  const [projectId, setProjectId] = useState<string>(defaultProjectId ?? "");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [overwritePending, setOverwritePending] = useState(false);

  const uploadM = useMutation<
    Weight,
    Error,
    { projectId: string; input: UploadWeightInput; overwroteId?: string }
  >({
    mutationFn: ({ projectId: pid, input }) => weightsApi.upload(pid, input),
    onSuccess: (_data, vars) => {
      showToast(
        vars.overwroteId ? "Weight overwritten" : "Weight uploaded",
        { variant: "success" },
      );
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
    setOverwritePending(false);
  }

  const effectiveProjectId = projectId || defaultProjectId || projects[0]?.id || "";
  const isBusy = uploadM.isPending || overwritePending;
  const canSubmit =
    !!file && name.trim().length > 0 && !!effectiveProjectId && !isBusy;

  function findDuplicate(targetName: string): Weight | null {
    const needle = targetName.trim().toLowerCase();
    if (!needle) return null;
    return (
      existingWeights.find((w) => w.name.trim().toLowerCase() === needle) ??
      null
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!file || !effectiveProjectId) return;
    setErrorMsg(null);
    const trimmedName = name.trim();

    const duplicate = findDuplicate(trimmedName);
    if (duplicate) {
      const ok = await confirm({
        title: "Weight already exists",
        description: (
          <>
            A weight named{" "}
            <span className="font-medium text-[color:var(--text-primary)]">
              {duplicate.name}
            </span>{" "}
            is already uploaded. Do you want to overwrite it with this new
            file? The previous weight will be permanently replaced.
          </>
        ),
        variant: "danger",
        confirmLabel: "Overwrite",
        cancelLabel: "Cancel",
      });
      if (!ok) return;

      setOverwritePending(true);
      try {
        await weightsApi.delete(duplicate.id);
      } catch (err) {
        setOverwritePending(false);
        setErrorMsg(
          err instanceof Error
            ? err.message
            : "Failed to delete existing weight",
        );
        return;
      }
      setOverwritePending(false);
      uploadM.mutate({
        projectId: effectiveProjectId,
        input: {
          name: trimmedName,
          task_kind: taskKind,
          class_names: [],
          file,
        },
        overwroteId: duplicate.id,
      });
      return;
    }

    uploadM.mutate({
      projectId: effectiveProjectId,
      input: {
        name: trimmedName,
        task_kind: taskKind,
        class_names: [],
        file,
      },
    });
  }

  const duplicatePreview = findDuplicate(name);

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
            for inference. We&apos;ll extract the class names from your weight file
            after upload.
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
          {duplicatePreview && (
            <p
              className="text-[12px] text-[color:var(--warning,#d97706)] -mt-1"
              data-testid="upload-duplicate-warning"
            >
              A weight named “{duplicatePreview.name}” already exists. You
              will be asked to overwrite it on upload.
            </p>
          )}

          <label className="grid gap-1.5">
            <span className="text-[12px] tracking-tight text-[color:var(--text-secondary)] font-medium">
              Task kind
            </span>
            <Select
              value={taskKind}
              onValueChange={(v) =>
                setTaskKind(v as UploadWeightInput["task_kind"])
              }
            >
              <Select.Trigger aria-label="Task kind" className="h-9 w-full">
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                {TASK_KINDS.map((k) => (
                  <Select.Item key={k} value={k}>
                    {k}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
          </label>

          <label className="grid gap-1.5">
            <span className="text-[12px] tracking-tight text-[color:var(--text-secondary)] font-medium">
              Project
            </span>
            {projects.length === 0 ? (
              <p className="text-[12.5px] text-[color:var(--text-tertiary)]">
                No projects yet
              </p>
            ) : (
              <Select
                value={effectiveProjectId}
                onValueChange={setProjectId}
              >
                <Select.Trigger aria-label="Project" className="h-9 w-full">
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  {projects.map((p: Project) => (
                    <Select.Item key={p.id} value={p.id}>
                      {p.name}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select>
            )}
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
              loading={isBusy}
              disabled={!canSubmit}
              leftIcon={!isBusy && <Upload className="h-4 w-4" />}
            >
              {duplicatePreview ? "Overwrite" : "Upload"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
