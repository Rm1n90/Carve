// Armin Mehri — mehri.armin@gmail.com
/**
 * HealthPanel — right-rail card that surfaces suspicious annotations
 * found by ``lib/annotation-health``.
 *
 * The chip always renders so the user can build a habit of glancing
 * at it; when no flags exist the body collapses to a single "looks
 * good" line. When flags exist the body lists one row per flagged
 * annotation with a Focus button that selects it (which the canvas
 * follows with its existing pan-to-selection behaviour).
 *
 * The component owns its expansion state. Hidden / locked / class-
 * hidden annotations are filtered out *before* running the detectors
 * so the user isn't nagged about things they've intentionally muted.
 */
import { useMemo, useState } from "react";
import {
  computeAnnotationFlags,
  flagLabel,
  type Flag,
} from "@/lib/annotation-health";
import { useAnnotations, type AnnotationDraft } from "@/state/annotations";
import { cn } from "@/lib/cn";

interface Props {
  /** Current frame id (null for image assets) — restricts flag scope to the visible frame. */
  frameId: string | null;
  /** Image dimensions for the off-image / whole-image detectors. */
  imageSize: { w: number; h: number } | null;
}

export function HealthPanel({ frameId, imageSize }: Props) {
  const byId = useAnnotations((s) => s.byId);
  const hiddenAnn = useAnnotations((s) => s.hiddenAnnotationIds);
  const hiddenClass = useAnnotations((s) => s.hiddenClassIds);
  const lockedIds = useAnnotations((s) => s.lockedIds);
  const select = useAnnotations((s) => s.select);
  const [expanded, setExpanded] = useState(false);

  const drafts: AnnotationDraft[] = useMemo(() => {
    return Object.values(byId).filter((d) => {
      if (d.frameId !== frameId) return false;
      if (hiddenAnn.includes(d.tempId)) return false;
      if (hiddenClass.includes(d.classId)) return false;
      if (lockedIds.has(d.tempId)) return false;
      return true;
    });
  }, [byId, frameId, hiddenAnn, hiddenClass, lockedIds]);

  const flags: Flag[] = useMemo(() => {
    return computeAnnotationFlags(drafts, imageSize);
  }, [drafts, imageSize]);

  const counts = useMemo(() => {
    let warn = 0;
    let info = 0;
    for (const f of flags) {
      if (f.severity === "warn") warn += 1;
      else info += 1;
    }
    return { warn, info, total: flags.length };
  }, [flags]);

  return (
    <div
      data-testid="health-panel"
      className={cn(
        "rounded-[var(--radius-6)] border border-[var(--border-subtle)]",
        "bg-[var(--bg-elev)] p-2 text-[12.5px]",
      )}
    >
      <button
        type="button"
        data-testid="health-panel-trigger"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "flex w-full items-center justify-between gap-2",
          "px-1 py-1 rounded-[var(--radius-xs)]",
          "hover:bg-[var(--bg-hover)] transition-colors duration-[180ms]",
        )}
        aria-expanded={expanded}
      >
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            className={cn(
              "inline-block h-2 w-2 rounded-full",
              counts.warn > 0
                ? "bg-[color:var(--accent-warning,#f59e0b)]"
                : counts.total > 0
                ? "bg-[color:var(--accent-info,#3b82f6)]"
                : "bg-[color:var(--text-tertiary,#888)]",
            )}
          />
          <span className="font-medium text-[color:var(--text-primary)]">
            Annotation health
          </span>
        </span>
        <span className="text-[color:var(--text-tertiary)] tabular-nums">
          {counts.total === 0
            ? "looks good"
            : `${counts.total} issue${counts.total === 1 ? "" : "s"}`}
        </span>
      </button>
      {expanded && counts.total > 0 ? (
        <ul
          data-testid="health-panel-list"
          className="mt-1 max-h-48 overflow-y-auto"
        >
          {flags.map((f, idx) => {
            const draft = byId[f.tempId];
            const title = draft?.classId ?? "(removed)";
            return (
              <li
                key={`${f.tempId}-${f.code}-${idx}`}
                className={cn(
                  "flex items-center justify-between gap-2",
                  "px-1 py-1 rounded-[var(--radius-xs)]",
                  "hover:bg-[var(--bg-hover)]",
                )}
              >
                <span className="flex flex-col">
                  <span className="text-[color:var(--text-primary)] truncate">
                    {title}
                  </span>
                  <span
                    className={cn(
                      "text-[11px] truncate",
                      f.severity === "warn"
                        ? "text-[color:var(--accent-warning,#f59e0b)]"
                        : "text-[color:var(--text-tertiary)]",
                    )}
                  >
                    {flagLabel(f.code)}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => select(f.tempId)}
                  className={cn(
                    "px-2 h-6 rounded-[var(--radius-xs)]",
                    "text-[11px] text-[color:var(--text-secondary)]",
                    "border border-[var(--border-subtle)]",
                    "hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
                  )}
                  data-testid={`health-focus-${f.tempId}`}
                >
                  Focus
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
