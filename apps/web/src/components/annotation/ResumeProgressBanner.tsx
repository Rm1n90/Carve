// Armin Mehri — mehri.armin@gmail.com
import { useEffect, useState } from "react";

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
 *
 * Queued behind any other open Radix dialog or alert-dialog (e.g.
 * the SAM-variant prompt on first task entry, which is a
 * `role="alertdialog"`) so this dialog is never visually buried. A
 * MutationObserver waits for the field to clear, then opens — the
 * field-clear check looks at both `role="dialog"` and
 * `role="alertdialog"`.
 */
export function ResumeProgressBanner({
  projectId,
  taskId,
  currentAssetId,
  onResume,
}: ResumeProgressBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  const [readyToShow, setReadyToShow] = useState(false);
  const { data, isLoading } = useTaskResume(projectId, taskId);

  const wantsToOpen =
    !isLoading &&
    !!data &&
    !dismissed &&
    data.last_asset_id !== null &&
    data.last_asset_id !== currentAssetId;

  // Open only when the field has been clear for SETTLE_MS continuously.
  // This handles two cases:
  //   1. A foreign dialog (e.g. SAM-variant) is already on screen — we
  //      wait for it to close.
  //   2. A foreign dialog is about to mount but hasn't yet — our hook
  //      resolved a tick earlier than theirs. The settle delay lets the
  //      page quiesce so we don't open then immediately get buried.
  useEffect(() => {
    if (!wantsToOpen) {
      setReadyToShow(false);
      return;
    }
    const SETTLE_MS = 400;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const isFieldClear = () =>
      document.querySelectorAll('[role="dialog"], [role="alertdialog"]')
        .length === 0;
    const scheduleOpen = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (!isFieldClear()) return;
      timer = setTimeout(() => {
        if (isFieldClear()) setReadyToShow(true);
      }, SETTLE_MS);
    };
    scheduleOpen();
    const obs = new MutationObserver(() => scheduleOpen());
    obs.observe(document.body, { childList: true, subtree: false });
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      obs.disconnect();
    };
  }, [wantsToOpen]);

  if (!wantsToOpen || !readyToShow) return null;

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
            You&rsquo;ve annotated{" "}
            <strong className="text-[color:var(--text-primary)]">
              {data.annotated_assets}{" "}
              {data.annotated_assets === 1 ? "image" : "images"}
            </strong>{" "}
            in this task ({data.total_assets} total)
            {relativeTime ? `. Last activity ${relativeTime}` : ""}.
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
