// Armin Mehri — mehri.armin@gmail.com
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";

import { useTaskResume } from "../../hooks/useTaskResume";
import { formatRelativeTime } from "../../lib/relativeTime";

interface ResumeProgressBannerProps {
  projectId: string | undefined;
  taskId: string | undefined;
  /** asset id currently displayed in the editor */
  currentAssetId: string | undefined;
  /** parent navigates to (taskId, assetId) on Resume click */
  onResume: (assetId: string) => void;
}

/**
 * Editor "welcome back" dialog. Tells the user where they left off in
 * this task and offers to jump there. Per-user, per-task. In-memory
 * dismiss only — re-opening the task brings the dialog back.
 *
 * Hidden when:
 *   - the resume query is loading
 *   - the user has no annotations here yet
 *   - the resume target is the asset already on screen
 *   - the user dismissed it in this session (Dismiss button, overlay
 *     click, ESC, or X close — all routed through onOpenChange).
 */
export function ResumeProgressBanner({
  projectId,
  taskId,
  currentAssetId,
  onResume,
}: ResumeProgressBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  const { data, isLoading } = useTaskResume(projectId, taskId);

  const shouldOpen =
    !isLoading &&
    !!data &&
    !dismissed &&
    data.last_asset_id !== null &&
    data.last_asset_id !== currentAssetId;

  if (!shouldOpen) return null;

  const relativeTime = formatRelativeTime(data.last_activity_at);
  const targetAssetId = data.last_asset_id as string;

  const handleResume = () => {
    setDismissed(true);
    onResume(targetAssetId);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) setDismissed(true);
      }}
    >
      <DialogContent data-testid="resume-progress-banner">
        <DialogHeader>
          <DialogTitle>Welcome back</DialogTitle>
          <DialogDescription>
            You last annotated{" "}
            <strong className="text-[color:var(--text-primary)]">
              {data.annotated_assets} of {data.total_assets}
            </strong>{" "}
            images here
            {relativeTime ? ` — last activity ${relativeTime}` : ""}.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setDismissed(true)}>
            Dismiss
          </Button>
          <Button variant="primary" onClick={handleResume}>
            Resume there
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
