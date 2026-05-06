// Armin Mehri — mehri.armin@gmail.com
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/Popover";
import { Checkbox } from "@/components/ui/Checkbox";
import { Tooltip } from "@/components/ui/Tooltip";
import { useEditorSettings, type ColorBy } from "@/state/editorSettings";
import { useTool } from "@/state/tool";
import { PALETTE_HEX } from "@/lib/swatch";
import { cn } from "@/lib/cn";

const COLOR_BY_OPTIONS: { value: ColorBy; label: string }[] = [
  { value: "label", label: "Label" },
  { value: "instance", label: "Instance" },
  { value: "group", label: "Group" },
];

function SliderRow({
  label,
  value,
  onChange,
  testId,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  testId: string;
}) {
  return (
    <div className="grid gap-0.5">
      <div className="flex items-center justify-between text-[10.5px] text-[color:var(--text-secondary)]">
        <span>{label}</span>
        <span
          className="font-mono text-[10px] text-[color:var(--text-tertiary)] tabular-nums"
          data-testid={`${testId}-value`}
        >
          {value}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        data-testid={testId}
        className="h-3 w-full accent-[var(--accent)]"
      />
    </div>
  );
}

function ColorChipPicker({
  color,
  onChange,
  ariaLabel,
  testId,
}: {
  color: string;
  onChange: (c: string) => void;
  ariaLabel: string;
  testId: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          data-testid={testId}
          className={cn(
            "h-4 w-4 shrink-0 rounded-[var(--radius-xs)] border border-[var(--border-strong)]",
            "transition-transform hover:scale-110",
          )}
          style={{ background: color }}
        />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={4}
        className="grid grid-cols-6 gap-1 p-2"
      >
        {/* White goes first so the default color is reachable. */}
        <button
          type="button"
          aria-label="Set outline color white"
          data-testid={`${testId}-option-FFFFFF`}
          onClick={() => onChange("#FFFFFF")}
          className="h-6 w-6 rounded-[var(--radius-xs)] border border-[var(--border-subtle)] hover:scale-110 transition-transform"
          style={{ background: "#FFFFFF" }}
        />
        {PALETTE_HEX.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`Set outline color ${c}`}
            data-testid={`${testId}-option-${c.replace("#", "")}`}
            onClick={() => onChange(c)}
            className={cn(
              "h-6 w-6 rounded-[var(--radius-xs)] border border-[var(--border-subtle)]",
              "hover:scale-110 transition-transform",
            )}
            style={{ background: c }}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}

interface CheckboxRowProps {
  checked: boolean;
  onChange?: (v: boolean) => void;
  label: string;
  testId: string;
  disabled?: boolean;
  /** When set, the row wraps in a tooltip explaining why it's disabled. */
  disabledReason?: string;
  /** Optional inline content rendered to the right of the label. */
  trailing?: React.ReactNode;
}

function CheckboxRow({
  checked,
  onChange,
  label,
  testId,
  disabled,
  disabledReason,
  trailing,
}: CheckboxRowProps) {
  const inner = (
    <label
      data-testid={`${testId}-row`}
      className={cn(
        "flex items-center gap-1.5 text-[10.5px] tracking-tight",
        disabled
          ? "text-[color:var(--text-tertiary)] cursor-not-allowed opacity-70"
          : "text-[color:var(--text-secondary)] cursor-pointer hover:text-[color:var(--text-primary)]",
      )}
    >
      <Checkbox
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
        data-testid={testId}
        className="h-3 w-3"
        boxClassName="h-3 w-3"
      />
      <span className="flex-1">{label}</span>
      {trailing}
    </label>
  );
  if (disabled && disabledReason) {
    return <Tooltip content={disabledReason}>{inner}</Tooltip>;
  }
  return inner;
}

/**
 * Right-panel "Appearance" disclosure mirroring CVAT's side-panel
 * Appearance section. Placed at the bottom of the side panel (below the
 * Classes / Objects tabs) so it's always visible regardless of the
 * active tab.
 *
 * All controls are wired straight to ``useEditorSettings``; persistence
 * happens automatically via the store's localStorage layer. The
 * outlined-borders + color picker round-trip into ``ShapeRenderer`` via
 * the ``outlinedBorders`` / ``outlinedBorderColor`` settings.
 *
 * No new dependencies were added — Radix Collapsible isn't installed in
 * this project, so the disclosure is a controlled `useState`-driven
 * button + content pair. Functionally equivalent to a Radix Collapsible
 * for the simple expand/collapse interaction we need.
 */
interface AppearancePanelProps {
  /** v3.24.7 — when true, renders the controls directly without the
   *  expand/collapse disclosure header. Use this when the panel is
   *  embedded inside a popover that already provides chrome. Default
   *  is false (legacy in-rail layout with a collapsible header). */
  compact?: boolean;
}

export function AppearancePanel(
  { compact = false }: AppearancePanelProps = {},
) {
  const settings = useEditorSettings();
  const set = useEditorSettings((s) => s.set);
  const [open, setOpen] = useState(true);
  const visibility = useTool((s) => s.visibility);
  const setVisibility = useTool((s) => s.setVisibility);

  // Shared content body — used by both the collapsible legacy layout
  // and the compact popover layout. Pulled out of the JSX tree below
  // so we can render it twice without duplicating the controls.
  const body = (
    <div
      id="appearance-panel-content"
      className={compact ? "grid gap-2 p-3 min-w-[240px]" : "px-2 pb-2 grid gap-1.5"}
    >
          {/* Color by — segmented control */}
          <div className="grid gap-0.5">
            <span className="text-[10.5px] text-[color:var(--text-secondary)]">
              Color by
            </span>
            <div
              role="radiogroup"
              aria-label="Color by"
              className="grid grid-cols-3 gap-0.5"
            >
              {COLOR_BY_OPTIONS.map((opt) => {
                const active = settings.colorBy === opt.value;
                const node = (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => set("colorBy", opt.value)}
                    data-testid={`appearance-colorBy-${opt.value}`}
                    data-active={active ? "true" : undefined}
                    className={cn(
                      "h-6 px-1 inline-flex items-center justify-center rounded-[var(--radius-sm)] border text-[10.5px]",
                      active
                        ? "border-[var(--accent)] bg-[var(--accent-bg)] text-[color:var(--accent)]"
                        : "border-[var(--glass-border)] bg-transparent text-[color:var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[color:var(--text-primary)]",
                    )}
                  >
                    {opt.label}
                  </button>
                );
                if (opt.value === "group") {
                  return (
                    <Tooltip
                      key={opt.value}
                      content="Groups aren't supported yet — falls back to Label color."
                    >
                      {node}
                    </Tooltip>
                  );
                }
                return node;
              })}
            </div>
          </div>

          <SliderRow
            label="Opacity"
            value={settings.opacity}
            onChange={(v) => set("opacity", v)}
            testId="appearance-opacity"
          />
          <SliderRow
            label="Selected opacity"
            value={settings.selectedOpacity}
            onChange={(v) => set("selectedOpacity", v)}
            testId="appearance-selectedOpacity"
          />

          {/* Outlined borders + inline color picker */}
          <CheckboxRow
            label="Outlined borders"
            checked={settings.outlinedBorders}
            onChange={(v) => set("outlinedBorders", v)}
            testId="appearance-outlinedBorders"
            trailing={
              <ColorChipPicker
                color={settings.outlinedBorderColor}
                onChange={(c) => set("outlinedBorderColor", c)}
                ariaLabel="Outlined border color"
                testId="appearance-outlinedBorderColor"
              />
            }
          />

          {/* Show bitmap — gates mask raster rendering. */}
          <CheckboxRow
            label="Show bitmap"
            checked={visibility.pixels}
            onChange={(v) => setVisibility("pixels", v)}
            testId="appearance-showBitmap"
          />

          {/* Show projections — disabled with a tooltip until v3. */}
          <CheckboxRow
            label="Show projections"
            checked={false}
            disabled
            disabledReason="Coming with skeleton/keypoint tools (v3)"
            testId="appearance-showProjections"
          />
    </div>
  );

  // Compact mode: drop the disclosure header — the popover already
  // provides the chrome (its own surround + arrow + close-on-outside).
  if (compact) {
    return (
      <section
        data-testid="appearance-panel"
        aria-label="Appearance"
        className="bg-transparent"
      >
        <div className="px-3 pt-2.5 pb-1 text-[10.5px] uppercase tracking-[0.08em] font-medium text-[color:var(--text-tertiary)]">
          Appearance
        </div>
        {body}
      </section>
    );
  }

  // Legacy in-rail mode: collapsible disclosure (kept for back-compat
  // even though the new right-rail layout drops this branch).
  return (
    <section
      data-testid="appearance-panel"
      aria-label="Appearance"
      className="border-t border-[var(--glass-border)] bg-transparent"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls="appearance-panel-content"
        onClick={() => setOpen((v) => !v)}
        data-testid="appearance-panel-toggle"
        className={cn(
          "w-full flex items-center gap-1.5 px-2 py-1.5",
          "text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)]",
          "transition-colors duration-[180ms] ease-out",
        )}
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <span className="flex-1 text-left text-[11px] uppercase tracking-[0.08em] font-medium leading-none">
          Appearance
        </span>
      </button>
      {open && body}
    </section>
  );
}
