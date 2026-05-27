// Armin Mehri — mehri.armin@gmail.com
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import type { ExtractMode } from "../../api/video_extract";

interface Props {
  videoCount: number;
  defaultMode?: ExtractMode;
  defaultK?: number;
  defaultN?: number;
  defaultQuality?: number;
  onCancel: () => void;
  onBack: () => void;
  onContinue: (params: {
    mode: ExtractMode;
    n_or_k: number;
    quality: number;
  }) => void;
}

const MODES: { value: ExtractMode; label: string; help: string }[] = [
  {
    value: "auto",
    label: "Auto",
    help: "Caps at ~500 frames; downsamples long videos.",
  },
  {
    value: "all",
    label: "All frames",
    help: "Every frame. Most accurate; biggest storage.",
  },
  {
    value: "every_nth",
    label: "Every N-th frame",
    help: "Skip in steps. Good for high-fps videos.",
  },
  {
    value: "count",
    label: "Total of K frames (smart)",
    help: "Evenly spaced K frames across the video.",
  },
];

export function VideoExtractParamsStep({
  videoCount,
  defaultMode = "count",
  defaultK = 500,
  defaultN = 5,
  defaultQuality = 75,
  onCancel,
  onBack,
  onContinue,
}: Props) {
  const [mode, setMode] = useState<ExtractMode>(defaultMode);
  const [k, setK] = useState<number>(defaultK);
  const [n, setN] = useState<number>(defaultN);
  const [quality, setQuality] = useState<number>(defaultQuality);

  const numericValue = mode === "count" ? k : mode === "every_nth" ? n : 0;
  const canContinue = useMemo(() => {
    if (mode === "auto" || mode === "all") return true;
    return Number.isFinite(numericValue) && numericValue > 0;
  }, [mode, numericValue]);

  const headerNoun = videoCount === 1 ? "video detected" : "videos detected";

  return (
    <div
      data-testid="video-extract-params-step"
      className="flex flex-col gap-4"
    >
      <p className="text-[13px] text-[color:var(--text-secondary)]">
        {videoCount} {headerNoun} — pick how many frames to extract. The same
        setting applies to every video.
      </p>

      <fieldset className="flex flex-col gap-2" aria-label="Extraction mode">
        {MODES.map((opt) => (
          <label
            key={opt.value}
            className={
              "flex items-start gap-2 rounded-[var(--radius-sm)] border px-3 py-2 cursor-pointer " +
              (mode === opt.value
                ? "border-[var(--accent)] bg-[color-mix(in_oklch,var(--accent)_8%,transparent)]"
                : "border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]")
            }
          >
            <input
              type="radio"
              name="mode"
              value={opt.value}
              checked={mode === opt.value}
              onChange={() => setMode(opt.value)}
              className="mt-1"
            />
            <span className="flex flex-col">
              <span className="text-[13px] font-medium text-[color:var(--text-primary)]">
                {opt.label}
              </span>
              <span className="text-[12px] text-[color:var(--text-tertiary)]">
                {opt.help}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {mode === "count" && (
        <label className="flex flex-col gap-1 text-[12px]">
          <span>K (total frames):</span>
          <input
            type="number"
            min={1}
            value={k}
            onChange={(e) => setK(parseInt(e.target.value, 10) || 0)}
            aria-label="K (total frames)"
            className="h-8 w-32 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] px-2 text-[13px]"
          />
        </label>
      )}
      {mode === "every_nth" && (
        <label className="flex flex-col gap-1 text-[12px]">
          <span>N (step):</span>
          <input
            type="number"
            min={1}
            value={n}
            onChange={(e) => setN(parseInt(e.target.value, 10) || 0)}
            aria-label="N (step)"
            className="h-8 w-32 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] px-2 text-[13px]"
          />
        </label>
      )}

      <label className="flex flex-col gap-1 text-[12px]">
        <span className="flex items-center justify-between">
          <span>Quality</span>
          <span className="font-mono tabular-nums text-[color:var(--text-tertiary)]">
            {quality} / 100
          </span>
        </span>
        <input
          type="range"
          min={1}
          max={100}
          step={1}
          value={quality}
          onChange={(e) => setQuality(parseInt(e.target.value, 10))}
          aria-label="Quality"
          className="w-full"
        />
      </label>

      <div className="mt-2 flex items-center justify-between gap-2">
        <Button variant="secondary" onClick={onBack}>
          ← Back
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!canContinue}
            onClick={() =>
              onContinue({
                mode,
                n_or_k:
                  mode === "auto" || mode === "all" ? 0 : numericValue,
                quality,
              })
            }
          >
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}
