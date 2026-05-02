import { useState, type ReactNode } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { Info, RotateCcw } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Tooltip, TooltipProvider } from "@/components/ui/Tooltip";
import {
  useEditorSettings,
  type CanvasPattern,
  type ColorBy,
  type LabelPosition,
  type LabelTextFlags,
  type PlayerSpeed,
} from "@/state/editorSettings";
import { cn } from "@/lib/cn";

const DEFERRED_TOOLTIP = "Not yet implemented in Carve.";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PLAYER_SPEEDS: PlayerSpeed[] = [
  "slowest",
  "slow",
  "usual",
  "fast",
  "fastest",
];

const LABEL_POSITIONS: LabelPosition[] = [
  "auto",
  "above",
  "below",
  "left",
  "right",
];

const COLOR_BYS: { value: ColorBy; label: string }[] = [
  { value: "label", label: "Label" },
  { value: "instance", label: "Instance" },
  { value: "group", label: "Group" },
];

const CANVAS_PATTERNS: { value: CanvasPattern; label: string }[] = [
  { value: "none", label: "None" },
  { value: "subtle", label: "Subtle" },
  { value: "visible", label: "Visible" },
];

const LABEL_TEXT_KEYS: { key: keyof LabelTextFlags; label: string }[] = [
  { key: "id", label: "ID" },
  { key: "source", label: "Source" },
  { key: "label", label: "Label" },
  { key: "attributes", label: "Attributes" },
  { key: "descriptions", label: "Descriptions" },
];

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-[12.5px] font-medium tracking-tight text-[color:var(--text-secondary)]">
        {label}
      </span>
      {children}
      {hint && (
        <span className="text-[11px] text-[color:var(--text-tertiary)]">{hint}</span>
      )}
    </label>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
  unit = "%",
  testId,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
  unit?: string;
  testId?: string;
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[12.5px] font-medium tracking-tight text-[color:var(--text-secondary)]">
          {label}
        </span>
        <span
          className="text-[11.5px] font-mono tabular-nums text-[color:var(--text-primary)]"
          data-testid={testId ? `${testId}-value` : undefined}
        >
          {value}
          {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        data-testid={testId}
        aria-label={label}
        className="w-full accent-[var(--accent)]"
      />
    </div>
  );
}

function NumberInput({
  value,
  min,
  max,
  step,
  onChange,
  testId,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
  testId?: string;
}) {
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (!Number.isFinite(n)) return;
        onChange(Math.max(min, Math.min(max, n)));
      }}
      data-testid={testId}
      className="h-8 px-2 rounded-[var(--radius-sm)] border border-[var(--glass-border)] bg-[var(--glass-bg-subtle)] text-[13px] focus:outline-none focus:border-[var(--accent)]"
    />
  );
}

function Select<T extends string>({
  value,
  options,
  onChange,
  testId,
}: {
  value: T;
  options: readonly T[] | { value: T; label: string }[];
  onChange: (v: T) => void;
  testId?: string;
}) {
  const opts: { value: T; label: string }[] = Array.isArray(options)
    ? (options as Array<T | { value: T; label: string }>).map((o) => {
        if (typeof o === "string") {
          const s = o as string;
          return { value: s as T, label: s[0].toUpperCase() + s.slice(1) };
        }
        return o as { value: T; label: string };
      })
    : [];
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      data-testid={testId}
      className="h-8 px-2 rounded-[var(--radius-sm)] border border-[var(--glass-border)] bg-[var(--glass-bg-subtle)] text-[13px] focus:outline-none focus:border-[var(--accent)]"
    >
      {opts.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
  testId,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  testId?: string;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-[12.5px] text-[color:var(--text-secondary)] cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-[var(--accent)]"
        data-testid={testId}
      />
      <span>{label}</span>
    </label>
  );
}

/**
 * Read-only checkbox with an explanatory tooltip. Used for CVAT-derived
 * settings whose underlying engine (interpolation, polygon helpers, AAM)
 * isn't implemented in Carve yet. The user can still see the option exists
 * and learn why it's disabled instead of silently doing nothing.
 */
function DeferredCheckbox({
  checked,
  label,
  testId,
  reason = DEFERRED_TOOLTIP,
}: {
  checked: boolean;
  label: string;
  testId?: string;
  reason?: string;
}) {
  return (
    <Tooltip content={reason} side="right" align="center">
      <label
        className="inline-flex items-center gap-2 text-[12.5px] text-[color:var(--text-tertiary)] cursor-not-allowed opacity-60"
        data-deferred="true"
        data-testid={testId ? `${testId}-row` : undefined}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled
          readOnly
          aria-disabled="true"
          className="h-3.5 w-3.5 accent-[var(--accent)]"
          data-testid={testId}
        />
        <span>{label}</span>
        <Info aria-hidden className="h-3 w-3 opacity-70" />
      </label>
    </Tooltip>
  );
}

export function EditorSettingsDialog({ open, onOpenChange }: Props) {
  const s = useEditorSettings();
  const [activeTab, setActiveTab] = useState<"player" | "workspace">("player");

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(92vw,560px)]">
        <TooltipProvider delayDuration={250}>
        <DialogHeader>
          <DialogTitle>Editor settings</DialogTitle>
          <DialogDescription>
            Personal preferences applied to this device. Settings persist across
            sessions.
          </DialogDescription>
        </DialogHeader>

        <Tabs.Root
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as "player" | "workspace")}
          data-testid="editor-settings-tabs"
        >
          <Tabs.List
            aria-label="Settings sections"
            className="flex gap-1 border-b border-[var(--border-subtle)] mb-4"
          >
            {(
              [
                { value: "player", label: "Player" },
                { value: "workspace", label: "Workspace" },
              ] as const
            ).map((t) => (
              <Tabs.Trigger
                key={t.value}
                value={t.value}
                data-testid={`tab-${t.value}`}
                className={cn(
                  "px-3 py-2 text-[13px] tracking-tight border-b-2 transition-colors",
                  "data-[state=active]:border-[var(--accent)] data-[state=active]:text-[color:var(--text-primary)]",
                  "data-[state=inactive]:border-transparent data-[state=inactive]:text-[color:var(--text-secondary)] data-[state=inactive]:hover:text-[color:var(--text-primary)]",
                )}
              >
                {t.label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>

          <Tabs.Content
            value="player"
            forceMount
            hidden={activeTab !== "player"}
            className="grid gap-4 data-[state=inactive]:hidden"
          >
            <Field
              label="Player step"
              hint="Frames to skip with First/Last buttons (1–100)."
            >
              <NumberInput
                value={s.playerStep}
                min={1}
                max={100}
                step={1}
                onChange={(v) => s.set("playerStep", v)}
                testId="setting-playerStep"
              />
            </Field>

            <Field label="Player speed">
              <Select
                value={s.playerSpeed}
                options={PLAYER_SPEEDS}
                onChange={(v) => s.set("playerSpeed", v)}
                testId="setting-playerSpeed"
              />
            </Field>

            <Checkbox
              checked={s.resetZoomOnFrameChange}
              onChange={(v) => s.set("resetZoomOnFrameChange", v)}
              label="Reset zoom on frame change"
              testId="setting-resetZoomOnFrameChange"
            />

            <Checkbox
              checked={s.smoothImage}
              onChange={(v) => s.set("smoothImage", v)}
              label="Smooth image (LINEAR sampling vs NEAREST)"
              testId="setting-smoothImage"
            />

            <Field
              label="Canvas backdrop"
              hint="Optional pattern for spotting transparency. Default is solid."
            >
              <div
                className="flex gap-2"
                role="radiogroup"
                aria-label="Canvas backdrop"
              >
                {CANVAS_PATTERNS.map((p) => (
                  <label
                    key={p.value}
                    className={cn(
                      "px-2.5 h-8 inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border text-[12.5px] cursor-pointer",
                      s.canvasPattern === p.value
                        ? "border-[var(--accent)] bg-[var(--accent-bg)] text-[color:var(--accent)]"
                        : "border-[var(--border-subtle)] text-[color:var(--text-secondary)] hover:border-[var(--border-strong)]",
                    )}
                  >
                    <input
                      type="radio"
                      name="canvasPattern"
                      value={p.value}
                      checked={s.canvasPattern === p.value}
                      onChange={() => s.set("canvasPattern", p.value)}
                      className="sr-only"
                      data-testid={`setting-canvasPattern-${p.value}`}
                    />
                    {p.label}
                  </label>
                ))}
              </div>
            </Field>

            <Field label="Backdrop color">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={s.canvasBgColor}
                  onChange={(e) => s.set("canvasBgColor", e.target.value)}
                  data-testid="setting-canvasBgColor"
                  aria-label="Canvas background color"
                  className="h-8 w-12 rounded-[var(--radius-sm)] border border-[var(--glass-border)] bg-[var(--glass-bg-subtle)]"
                />
                <span className="text-[12px] font-mono text-[color:var(--text-secondary)]">
                  {s.canvasBgColor}
                </span>
              </div>
            </Field>
          </Tabs.Content>

          <Tabs.Content
            value="workspace"
            forceMount
            hidden={activeTab !== "workspace"}
            className="grid gap-4 data-[state=inactive]:hidden"
          >
            <Field
              label="Auto-save interval (seconds)"
              hint="Debounce time for the autosave fired after annotation changes."
            >
              <NumberInput
                value={s.autoSaveIntervalSeconds}
                min={0.5}
                max={30}
                step={0.5}
                onChange={(v) => s.set("autoSaveIntervalSeconds", v)}
                testId="setting-autoSaveIntervalSeconds"
              />
            </Field>

            <Field label="Color by">
              <div className="flex gap-2" role="radiogroup" aria-label="Color by">
                {COLOR_BYS.map((c) => (
                  <label
                    key={c.value}
                    className={cn(
                      "px-2.5 h-8 inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border text-[12.5px] cursor-pointer",
                      s.colorBy === c.value
                        ? "border-[var(--accent)] bg-[var(--accent-bg)] text-[color:var(--accent)]"
                        : "border-[var(--border-subtle)] text-[color:var(--text-secondary)] hover:border-[var(--border-strong)]",
                    )}
                  >
                    <input
                      type="radio"
                      name="colorBy"
                      value={c.value}
                      checked={s.colorBy === c.value}
                      onChange={() => s.set("colorBy", c.value)}
                      className="sr-only"
                      data-testid={`setting-colorBy-${c.value}`}
                    />
                    {c.label}
                  </label>
                ))}
              </div>
              {s.colorBy === "group" && (
                <p
                  className="text-[11px] text-[color:var(--text-tertiary)] mt-1"
                  data-testid="setting-colorBy-group-note"
                >
                  Groups aren't supported yet — annotations fall back to the
                  class color.
                </p>
              )}
            </Field>

            <SliderRow
              label="Opacity"
              value={s.opacity}
              min={0}
              max={100}
              step={5}
              onChange={(v) => s.set("opacity", v)}
              testId="setting-opacity"
            />

            <SliderRow
              label="Selected opacity"
              value={s.selectedOpacity}
              min={0}
              max={100}
              step={5}
              onChange={(v) => s.set("selectedOpacity", v)}
              testId="setting-selectedOpacity"
            />

            <Field label="Label text">
              <div className="flex flex-wrap gap-3 pt-1">
                {LABEL_TEXT_KEYS.map((k) => (
                  <Checkbox
                    key={k.key}
                    checked={s.showLabelText[k.key]}
                    onChange={(v) => s.setLabelTextFlag(k.key, v)}
                    label={k.label}
                    testId={`setting-labelText-${k.key}`}
                  />
                ))}
              </div>
            </Field>

            <Field label="Label position">
              <Select
                value={s.labelPosition}
                options={LABEL_POSITIONS}
                onChange={(v) => s.set("labelPosition", v)}
                testId="setting-labelPosition"
              />
            </Field>

            <Field label="Label font size">
              <NumberInput
                value={s.labelFontSize}
                min={10}
                max={24}
                step={1}
                onChange={(v) => s.set("labelFontSize", v)}
                testId="setting-labelFontSize"
              />
            </Field>

            <Checkbox
              checked={s.showTagsOnFrame}
              onChange={(v) => s.set("showTagsOnFrame", v)}
              label="Show tags on frame"
              testId="setting-showTagsOnFrame"
            />

            <SliderRow
              label="Polygon approximation points"
              value={s.polygonApproxPoints}
              min={0}
              max={100}
              step={5}
              onChange={(v) => s.set("polygonApproxPoints", v)}
              testId="setting-polygonApproxPoints"
            />
            <p className="text-[11px] text-[color:var(--text-tertiary)] -mt-1">
              Affects mask → polygon conversion fidelity (used by SAM
              commits). 0 = raw pixel boundary, 100 = aggressively smoothed.
            </p>

            <Field
              label="Control point size"
              hint="Pixel size of the vertex/handle squares on selected polygons and bboxes."
            >
              <NumberInput
                value={s.controlPointsSize}
                min={4}
                max={12}
                step={1}
                onChange={(v) => s.set("controlPointsSize", v)}
                testId="setting-controlPointsSize"
              />
            </Field>

            {/* Plan-15 Track C — removed the "Advanced (CVAT parity,
                deferred)" group. Those toggles required underlying
                engines (interpolation, AAM, polygon helpers) that
                Carve does not implement, so they were inert. */}
          </Tabs.Content>
        </Tabs.Root>

        <div className="mt-6 flex justify-between items-center pt-3 border-t border-[var(--border-subtle)]">
          <button
            type="button"
            onClick={s.reset}
            data-testid="settings-reset"
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[var(--radius-sm)] text-[12.5px] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)]"
          >
            <RotateCcw className="h-3 w-3" />
            Reset to defaults
          </button>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="inline-flex items-center h-8 px-3 rounded-[var(--radius-sm)] text-[12.5px] font-medium bg-[var(--accent)] text-[color:var(--accent-fg)] hover:bg-[var(--accent-hover)]"
          >
            Done
          </button>
        </div>
        </TooltipProvider>
      </DialogContent>
    </Dialog>
  );
}
