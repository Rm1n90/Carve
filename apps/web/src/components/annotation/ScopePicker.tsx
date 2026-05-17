// Armin Mehri — mehri.armin@gmail.com
//
// v3.31 — shared scope picker for batch dialogs (Auto-Annotate,
// Smart Find, My Model). Three radios:
//   1. This image  — sync per-asset call
//   2. All assets  — task-wide batch (no filter)
//   3. Range       — task-wide batch filtered to a 1-based asset
//                    position range (From / To number inputs).
//
// The component is presentational — it accepts mode + range as
// controlled state from the parent so each dialog can persist them in
// its own per-task storage shape. It also surfaces the "live count"
// of assets the range will cover so the user knows exactly what Run
// will hit.
import type { ChangeEvent, ReactElement } from "react";

import { cn } from "@/lib/cn";
import { clampRange, type RangeInput, type ScopeMode } from "@/lib/scopeRange";

export interface ScopePickerProps {
  mode: ScopeMode;
  onModeChange: (next: ScopeMode) => void;
  range: RangeInput;
  onRangeChange: (next: RangeInput) => void;
  /** Total number of assets in the task. 0 disables All / Range. */
  totalAssets: number;
  /** Truthy iff we're inside an open task (drives All / Range gating). */
  hasTask: boolean;
  /** Truthy iff a single asset is open (drives This gating). */
  hasAsset: boolean;
  /** Stable prefix used to scope radio `name` attributes so multiple
   *  ScopePickers can render on the same page without their radio
   *  groups colliding. */
  name: string;
  /** Forwarded onto wrapper + inputs so existing test selectors and
   *  the AutoAnnotateDialog visual treatments keep working. */
  dataTestId?: string;
  /** Optional override map for the data-testid on each radio. Lets the
   *  YOLO predict popover keep its legacy ``yolo-predict-scope-asset``
   *  / ``yolo-predict-scope-task`` selectors that pre-existing test
   *  suites already depend on. */
  modeTestIds?: Partial<Record<ScopeMode, string>>;
}

export function ScopePicker({
  mode,
  onModeChange,
  range,
  onRangeChange,
  totalAssets,
  hasTask,
  hasAsset,
  name,
  dataTestId,
  modeTestIds,
}: ScopePickerProps): ReactElement {
  const rangeAvailable = hasTask && totalAssets > 0;
  const clamped = clampRange(range, totalAssets);
  const previewCount =
    mode === "range" && clamped.ok ? clamped.to - clamped.from + 1 : 0;
  const rawFrom = typeof range.from === "number" ? range.from : "";
  const rawTo = typeof range.to === "number" ? range.to : "";

  const testIdFor = (m: ScopeMode): string =>
    modeTestIds?.[m] ?? `${name}-${m}`;

  function parseField(e: ChangeEvent<HTMLInputElement>): number | "" {
    const raw = e.target.value;
    if (raw === "") return "";
    const n = Number(raw);
    if (!Number.isFinite(n)) return "";
    return Math.trunc(n);
  }

  return (
    <div
      className="grid gap-2"
      role="radiogroup"
      aria-label="Scope"
      data-testid={dataTestId ?? `${name}-scope`}
    >
      <div className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
        Scope
      </div>
      <div className="flex flex-col gap-1.5 text-[12.5px] text-[color:var(--text-primary)]">
        <label
          data-testid={testIdFor("this")}
          className={cn(
            "flex items-center gap-1.5",
            hasAsset ? "cursor-pointer" : "opacity-50 cursor-not-allowed",
          )}
          title={hasAsset ? "Run on the open asset" : "No asset open"}
        >
          <input
            type="radio"
            name={name}
            value="this"
            disabled={!hasAsset}
            checked={mode === "this"}
            onChange={() => onModeChange("this")}
          />
          This image
        </label>
        <label
          data-testid={testIdFor("all")}
          className={cn(
            "flex items-center gap-1.5",
            hasTask ? "cursor-pointer" : "opacity-50 cursor-not-allowed",
          )}
          title={hasTask ? "Run on every asset in this task" : "Task id missing"}
        >
          <input
            type="radio"
            name={name}
            value="all"
            disabled={!hasTask}
            checked={mode === "all"}
            onChange={() => onModeChange("all")}
          />
          All assets in this task
        </label>
        <label
          data-testid={testIdFor("range")}
          className={cn(
            "flex items-center gap-1.5",
            rangeAvailable ? "cursor-pointer" : "opacity-50 cursor-not-allowed",
          )}
          title={
            rangeAvailable
              ? "Run on a subset chosen by 1-based asset position"
              : hasTask
                ? "Task has no assets"
                : "Task id missing"
          }
        >
          <input
            type="radio"
            name={name}
            value="range"
            disabled={!rangeAvailable}
            checked={mode === "range"}
            onChange={() => onModeChange("range")}
          />
          Range
        </label>
        {mode === "range" && rangeAvailable && (
          <div
            className="ml-5 grid gap-1.5"
            data-testid={`${name}-range-inputs`}
          >
            <div className="flex items-center gap-2 text-[12px] text-[color:var(--text-secondary)]">
              <span>From</span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={totalAssets}
                step={1}
                value={rawFrom}
                onChange={(e) =>
                  onRangeChange({ ...range, from: parseField(e) })
                }
                aria-label="Range from (1-based asset position)"
                data-testid={`${name}-range-from`}
                className={cn(
                  "h-7 w-20 px-2 rounded-[var(--radius-sm)] border",
                  "border-[var(--border-subtle)] bg-[var(--bg-elev)]",
                  "text-[12px] text-[color:var(--text-primary)] outline-none",
                  "focus:border-[color:var(--accent)]",
                )}
              />
              <span>To</span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={totalAssets}
                step={1}
                value={rawTo}
                onChange={(e) =>
                  onRangeChange({ ...range, to: parseField(e) })
                }
                aria-label="Range to (1-based asset position)"
                data-testid={`${name}-range-to`}
                className={cn(
                  "h-7 w-20 px-2 rounded-[var(--radius-sm)] border",
                  "border-[var(--border-subtle)] bg-[var(--bg-elev)]",
                  "text-[12px] text-[color:var(--text-primary)] outline-none",
                  "focus:border-[color:var(--accent)]",
                )}
              />
              <span
                className="font-mono text-[11px] text-[color:var(--text-tertiary)]"
                data-testid={`${name}-range-bounds`}
              >
                / {totalAssets}
              </span>
            </div>
            <div
              className="text-[11px] text-[color:var(--text-tertiary)]"
              data-testid={`${name}-range-preview`}
            >
              {previewCount > 0
                ? `Will run on ${previewCount} asset${previewCount === 1 ? "" : "s"} (positions ${clamped.from}–${clamped.to}).`
                : "Pick a non-empty range to enable Run."}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
