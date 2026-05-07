// Armin Mehri — mehri.armin@gmail.com
import { Loader2 } from "lucide-react";

import { useTrackBridge } from "@/state/trackBridge";

/**
 * v3.27.9 — persistent floating progress chip for SAM 3.1 video
 * tracking. Mounts at the page level so the indicator survives the
 * user switching tools mid-propagation (changing to Drag/Bbox/etc.
 * unmounts the right-rail TrackPanel, but the propagation continues
 * server-side; users were left with no visible progress).
 *
 * Renders only when ``useTrackBridge.status === "running"``. Shows
 * ``Tracking N / M (X%)`` in a fixed bottom-right pill.
 */
export function TrackProgressBadge() {
  const status = useTrackBridge((s) => s.status);
  const propagated = useTrackBridge((s) => s.framesPropagated);
  const total = useTrackBridge((s) => s.totalFrames);

  if (status !== "running") return null;
  const pct = total > 0
    ? Math.min(100, Math.round((propagated / total) * 100))
    : 0;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="track-progress-badge"
      className="
        fixed bottom-4 right-4 z-50
        flex items-center gap-2
        px-3 py-2 rounded-full
        bg-[var(--bg-elevated)] glass-surface-strong
        border border-[var(--glass-border)]
        text-[12px] font-medium tabular-nums
        shadow-lg
      "
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />
      <span>
        Tracking {propagated} / {total}
      </span>
      <span className="text-[color:var(--text-tertiary)]">({pct}%)</span>
    </div>
  );
}
