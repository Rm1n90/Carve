// Armin Mehri — mehri.armin@gmail.com
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/cn";

export type ExtractStrategyKind = "auto" | "all" | "every_nth" | "count";

export interface ExtractStrategy {
  strategy: ExtractStrategyKind;
  n: number | null;
  quality: number;
}

export const DEFAULT_EXTRACT_STRATEGY: ExtractStrategy = {
  strategy: "count",
  n: 500,
  quality: 75,
};

interface Option {
  key: ExtractStrategyKind;
  title: string;
  desc: string;
}

const OPTIONS: readonly Option[] = [
  { key: "auto", title: "Auto", desc: "Caps at ~500 frames; downsamples long videos." },
  { key: "all", title: "All frames", desc: "Every frame. Most accurate; biggest storage." },
  { key: "every_nth", title: "Every N-th frame", desc: "Skip in steps. Good for high-fps videos." },
  { key: "count", title: "Total of K frames (smart)", desc: "Evenly spaced K frames across the video." },
];

interface Props {
  videoCount: number;
  value: ExtractStrategy;
  onChange: (next: ExtractStrategy) => void;
}

/**
 * v3.26 — pure presentational frame-extraction strategy picker.
 *
 * Used in two places:
 *  - AssetUploadDialog (Phase B "videoSetup") for the inline picker.
 *  - FrameExtractDialog (editor toolbar Re-extract) for the modal picker.
 *
 * Holds no I/O. Parent owns state via the controlled value/onChange pair.
 */
export function VideoExtractPanel({ videoCount, value, onChange }: Props) {
  const needsN = value.strategy === "every_nth" || value.strategy === "count";

  return (
    <div className="grid gap-3" data-testid="video-extract-panel">
      <p className="text-[12.5px] text-[color:var(--text-secondary)]">
        {videoCount} {videoCount === 1 ? "video" : "videos"} detected — pick how
        many frames to extract. The same setting applies to every video.
      </p>

      <div className="grid gap-2">
        {OPTIONS.map((opt) => {
          const active = value.strategy === opt.key;
          return (
            <label
              key={opt.key}
              data-testid={`frame-extract-strategy-${opt.key}`}
              className={cn(
                "flex items-start gap-2.5 px-3 py-2 cursor-pointer",
                "rounded-[var(--radius-sm)] border transition-colors",
                active
                  ? "border-[var(--accent)] bg-[var(--accent-bg)]"
                  : "border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]",
              )}
            >
              <input
                type="radio"
                name="video-extract-strategy"
                checked={active}
                onChange={() =>
                  onChange({
                    ...value,
                    strategy: opt.key,
                    n:
                      opt.key === "auto" || opt.key === "all"
                        ? null
                        : value.n ?? (opt.key === "count" ? 500 : 5),
                  })
                }
                className="mt-0.5"
              />
              <div className="grid gap-0.5">
                <div className="text-[13px] text-[color:var(--text-primary)]">
                  {opt.title}
                </div>
                <div className="text-[11.5px] text-[color:var(--text-tertiary)]">
                  {opt.desc}
                </div>
              </div>
            </label>
          );
        })}
      </div>

      {needsN && (
        <div className="flex items-center gap-2">
          <label
            htmlFor="frame-extract-n"
            className="text-[12px] text-[color:var(--text-secondary)]"
          >
            {value.strategy === "every_nth" ? "N (step):" : "K (total frames):"}
          </label>
          <Input
            id="frame-extract-n"
            type="number"
            min={1}
            max={100000}
            value={value.n ?? 1}
            onChange={(e) =>
              onChange({
                ...value,
                n: Math.max(1, parseInt(e.target.value, 10) || 1),
              })
            }
            data-testid="frame-extract-n"
            className="w-24"
          />
        </div>
      )}

      <div className="grid gap-1.5">
        <div className="flex items-center justify-between">
          <label
            htmlFor="frame-extract-quality"
            className="text-[12px] text-[color:var(--text-secondary)]"
          >
            Quality
          </label>
          <span className="font-mono text-[11.5px] text-[color:var(--text-tertiary)] tabular-nums">
            {value.quality} / 100
          </span>
        </div>
        <input
          id="frame-extract-quality"
          type="range"
          min={0}
          max={100}
          step={5}
          value={value.quality}
          onChange={(e) =>
            onChange({ ...value, quality: parseInt(e.target.value, 10) || 0 })
          }
          data-testid="frame-extract-quality"
        />
      </div>
    </div>
  );
}
