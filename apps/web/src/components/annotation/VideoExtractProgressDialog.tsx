// Armin Mehri — mehri.armin@gmail.com
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";

import { useVideoExtractBatch } from "../../hooks/useVideoExtractBatch";
import {
  videoExtractApi,
  type BatchJobItem,
} from "../../api/video_extract";

interface Props {
  projectId: string;
  taskId: string;
  batchId: string;
  /** User wants to dismiss but keep the work running. */
  onBackground: () => void;
  /** Entire batch is terminal AND we want to close. */
  onClose: () => void;
}

function rowStatusLabel(j: BatchJobItem): string {
  switch (j.status) {
    case "queued":
      return "queued";
    case "running":
      return `${j.frames_extracted} extracted`;
    case "succeeded":
      return `${j.frames_extracted} extracted ✓`;
    case "failed":
      return `failed — ${j.error_message ?? "unknown"}`;
    case "cancelled":
      return "cancelled";
  }
}

export function VideoExtractProgressDialog({
  projectId,
  taskId,
  batchId,
  onBackground,
  onClose,
}: Props) {
  const q = useVideoExtractBatch(projectId, taskId, batchId);
  const qc = useQueryClient();

  const jobs = q.data?.jobs ?? [];
  const overall =
    jobs.length === 0
      ? 0
      : Math.round(
          jobs.reduce((acc, j) => acc + j.progress, 0) / jobs.length,
        );
  const allTerminal =
    jobs.length > 0 &&
    jobs.every((j) =>
      ["succeeded", "failed", "cancelled"].includes(j.status),
    );

  useEffect(() => {
    if (!allTerminal) return;
    const id = setTimeout(() => onClose(), 1200);
    return () => clearTimeout(id);
  }, [allTerminal, onClose]);

  async function handleCancel() {
    await videoExtractApi.cancelBatch(projectId, taskId, batchId);
    qc.invalidateQueries({
      queryKey: ["video-extract-batch", projectId, taskId, batchId],
    });
  }

  const succeeded = jobs.filter((j) => j.status === "succeeded").length;

  return (
    <Dialog open onOpenChange={(open) => !open && onBackground()}>
      <DialogContent
        data-testid="video-extract-progress-dialog"
        className="w-[min(92vw,560px)]"
      >
        <DialogHeader>
          <DialogTitle>Extracting frames</DialogTitle>
          <DialogDescription>
            <span data-testid="video-extract-overall">Overall {overall}%</span>
            <span className="ml-2 text-[color:var(--text-tertiary)]">
              ({succeeded} of {jobs.length} done)
            </span>
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2">
          {jobs.map((j) => (
            <li
              key={j.job_id}
              className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] px-3 py-2"
              data-testid={`video-extract-row-${j.job_id}`}
            >
              <span className="truncate text-[13px] text-[color:var(--text-primary)]">
                {j.source_filename}
              </span>
              <span className="font-mono tabular-nums text-[12px] text-[color:var(--text-tertiary)]">
                {j.progress}%
              </span>
              <div className="col-span-2 h-1.5 overflow-hidden rounded-full bg-[var(--bg-subtle)]">
                <div
                  className={
                    j.status === "failed"
                      ? "h-full bg-[var(--danger)]"
                      : j.status === "succeeded"
                        ? "h-full bg-[var(--success)]"
                        : "h-full bg-[var(--accent)]"
                  }
                  style={{ width: `${j.progress}%` }}
                />
              </div>
              <span className="col-span-2 text-[11px] text-[color:var(--text-tertiary)]">
                {rowStatusLabel(j)}
              </span>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="secondary" onClick={onBackground}>
            Run in background
          </Button>
          <Button variant="danger" onClick={handleCancel} disabled={allTerminal}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
