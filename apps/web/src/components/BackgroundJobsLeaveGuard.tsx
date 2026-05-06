// Armin Mehri — mehri.armin@gmail.com
/**
 * Leave-guard for the asset annotate page (v3.22).
 *
 * Mounted by AnnotateAssetPage scoped to the current ``taskId``. Two
 * jobs:
 *
 *  1. SPA navigation — when the operator triggers a route change that
 *     leaves the task while one or more background jobs are still
 *     running, undo the navigation and show a confirm modal:
 *       Stay  -> dismiss the modal, do nothing
 *       Leave -> cancel every backgrounded job for this task and
 *                proceed with the original navigation
 *
 *  2. Browser tab close (window.beforeunload) — return a non-empty
 *     string so the browser shows the native "Leave page?" dialog.
 *     The browser cannot guarantee the in-flight cancel calls run, so
 *     this is a soft warning only; jobs that survive a tab close are
 *     still cooperative-cancelable on the server side once the user
 *     re-opens the editor.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { useBackgroundJobs } from "@/state/backgroundJobs";

interface Props {
  /** Current task id — guard runs only while the user is on this task's editor. */
  taskId: string;
}

export function BackgroundJobsLeaveGuard({ taskId }: Props) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const prevPathRef = useRef<string>(path);
  // The task path prefix — anything that doesn't include this counts
  // as "leaving the task".
  const taskPrefix = `/tasks/${taskId}`;
  // Outstanding navigation target the operator initiated; non-null
  // means we reverted them and are showing the confirm modal.
  const [pendingTarget, setPendingTarget] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);

  // SPA navigation interceptor.
  useEffect(() => {
    const prev = prevPathRef.current;
    if (path === prev) return;

    const onTaskBefore = prev.includes(taskPrefix);
    const onTaskNow = path.includes(taskPrefix);
    if (onTaskBefore && !onTaskNow) {
      const jobsForTask = useBackgroundJobs.getState().forTask(taskId);
      if (jobsForTask.length > 0) {
        // Block the navigation by snapping back. Stash the target
        // so the modal's Leave button can replay it.
        setPendingTarget(path);
        navigate({ to: prev, replace: true });
        return; // do not update prevPathRef — we're staying on prev
      }
    }
    prevPathRef.current = path;
  }, [path, taskId, taskPrefix, navigate]);

  // Browser tab close — show the native warning when jobs are running.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      const jobs = useBackgroundJobs.getState().forTask(taskId);
      if (jobs.length > 0) {
        e.preventDefault();
        // Modern browsers ignore the returned string but require
        // ``returnValue`` to be set for the prompt to appear.
        e.returnValue = "";
        return "";
      }
      return undefined;
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [taskId]);

  if (!pendingTarget) return null;

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) setPendingTarget(null);
      }}
    >
      <DialogContent className="w-[min(92vw,520px)]">
        <DialogHeader>
          <DialogTitle>Leave the task?</DialogTitle>
          <DialogDescription>
            You have running background jobs on this task. Leaving will
            cancel them — annotations already created will be kept.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-row gap-2 justify-end">
          <Button
            variant="ghost"
            size="md"
            onClick={() => setPendingTarget(null)}
            data-testid="bg-leave-stay"
          >
            Stay
          </Button>
          <Button
            variant="danger"
            size="md"
            disabled={canceling}
            loading={canceling}
            onClick={async () => {
              setCanceling(true);
              const target = pendingTarget;
              try {
                await useBackgroundJobs.getState().cancelByTask(taskId);
              } catch {
                /* best-effort */
              }
              setCanceling(false);
              setPendingTarget(null);
              if (target) {
                // Update prevPath so the next pathname-change effect
                // doesn't re-trigger the guard.
                prevPathRef.current = target;
                navigate({ to: target });
              }
            }}
            data-testid="bg-leave-cancel-and-go"
          >
            Cancel jobs and leave
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
