// Armin Mehri — mehri.armin@gmail.com
import { useState } from "react";

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
 * Editor banner. Tells the user where they left off in this task and
 * offers to jump there. Per-user, per-task. In-memory dismiss only —
 * re-opening the task brings the banner back.
 *
 * Hidden when:
 *   - the resume query is loading
 *   - the user has no annotations here yet
 *   - the resume target is the asset already on screen
 *   - the user dismissed it in this session
 */
export function ResumeProgressBanner({
  projectId,
  taskId,
  currentAssetId,
  onResume,
}: ResumeProgressBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  const { data, isLoading } = useTaskResume(projectId, taskId);

  if (isLoading || !data || dismissed) return null;
  if (data.last_asset_id === null) return null;
  if (data.last_asset_id === currentAssetId) return null;

  const relativeTime = formatRelativeTime(data.last_activity_at);
  const targetAssetId = data.last_asset_id;

  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 border-b border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-100"
      data-testid="resume-progress-banner"
    >
      <p>
        You last annotated{" "}
        <strong>
          {data.annotated_assets} of {data.total_assets}
        </strong>{" "}
        images here
        {relativeTime ? ` — last activity ${relativeTime}` : ""}.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          className="rounded bg-blue-600 px-3 py-1 text-white hover:bg-blue-500"
          onClick={() => onResume(targetAssetId)}
        >
          Resume there
        </button>
        <button
          type="button"
          className="rounded border border-zinc-600 px-3 py-1 text-zinc-200 hover:bg-zinc-800"
          onClick={() => setDismissed(true)}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
