import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, X } from "lucide-react";

import { modelsApi } from "@/api/phase2";
import { cn } from "@/lib/cn";

const DISMISS_KEY = "carve.samBanner.dismissedUntil";
const DISMISS_DAYS = 1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function readDismissedUntil(): number {
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY);
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function setDismissedUntil(value: number): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, String(value));
  } catch {
    /* localStorage may be unavailable */
  }
}

/**
 * Visible above the editor canvas when the model service is not running.
 * Shows the precise `docker compose` command to bring it up. The user
 * can dismiss for one day; after that we re-show on next mount when
 * SAM is still unreachable.
 *
 * Detection rule: `GET /api/models/sam-active` either errors OR returns
 * `available: []`. Both signals indicate the model service is offline.
 */
export function SamUnavailableBanner() {
  const q = useQuery({
    queryKey: ["sam-active"],
    queryFn: () => modelsApi.samActive(),
    retry: false,
  });
  const [dismissed, setDismissed] = useState<boolean>(() => {
    const until = readDismissedUntil();
    return until > Date.now();
  });

  // Re-evaluate the dismissal gate when the query first finishes.
  useEffect(() => {
    if (q.isFetched) {
      const until = readDismissedUntil();
      setDismissed(until > Date.now());
    }
  }, [q.isFetched]);

  // The API now returns a `reachable` field after probing the model
  // service. Treat any of: query error, no `available` variants, or
  // explicit `reachable: false` as unreachable.
  const reachable = q.data?.reachable;
  const unreachable =
    !!q.error ||
    (q.isFetched && (q.data?.available?.length ?? 0) === 0) ||
    (q.isFetched && reachable === false);

  if (!unreachable || dismissed || q.isLoading) return null;

  return (
    <div
      role="status"
      data-testid="sam-unavailable-banner"
      className={cn(
        "flex items-start gap-2 px-4 py-2.5 text-[12.5px] tracking-tight",
        "border-b border-[var(--border-subtle)] bg-[var(--bg-subtle)]",
      )}
    >
      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 text-[color:var(--danger)] shrink-0" />
      <span className="flex-1">
        <strong className="font-medium text-[color:var(--text-primary)]">
          Smart mode (SAM) is unavailable.
        </strong>{" "}
        <span className="text-[color:var(--text-secondary)]">
          The model service is not running. Start it with{" "}
          <code className="px-1 py-0.5 mx-0.5 rounded bg-[var(--glass-bg-subtle)] font-mono text-[11.5px] border border-[var(--border-subtle)]">
            docker compose --profile inference up -d
          </code>
          .
        </span>
      </span>
      <button
        type="button"
        onClick={() => {
          const until = Date.now() + DISMISS_DAYS * MS_PER_DAY;
          setDismissedUntil(until);
          setDismissed(true);
        }}
        aria-label="Dismiss"
        data-testid="sam-banner-dismiss"
        className="grid h-6 w-6 place-items-center rounded-[var(--radius-xs)] text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)] hover:bg-[var(--bg-hover)]"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
