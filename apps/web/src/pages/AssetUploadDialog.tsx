// Armin Mehri — mehri.armin@gmail.com
import { useState } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { useQueryClient } from "@tanstack/react-query";
import { Upload, FileImage, ArrowLeft } from "lucide-react";

import { assetsApi } from "@/api/assets";
import { Button } from "@/components/ui/Button";
import {
  VideoExtractPanel,
  DEFAULT_EXTRACT_STRATEGY,
  type ExtractStrategy,
} from "@/components/annotation/VideoExtractPanel";
import { useBackgroundJobs } from "@/state/backgroundJobs";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/cn";

// Plan-20.7 — accept by extension. The MIME-keyed react-dropzone config
// silently rejected ZIPs whose MIME wasn't ``application/zip`` (Windows
// reports ``application/x-zip-compressed``, some browsers report empty);
// rejected files never reach onDrop and the dialog showed "Uploaded 0 files".
const ALLOWED_UPLOAD_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".mp4",
  ".webm",
  ".mov",
  ".zip",
];

// Plan-20.8 — annotation files get a SPECIFIC rejection that points at the
// Import button instead of a generic "Unsupported file type".
const ANNOTATION_EXTENSIONS = [".txt", ".yaml", ".yml", ".json"];

function validateExtension(file: File) {
  const lower = file.name.toLowerCase();
  if (ALLOWED_UPLOAD_EXTENSIONS.some((ext) => lower.endsWith(ext))) return null;
  if (ANNOTATION_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return {
      code: "wrong-dialog-annotation",
      message:
        "That looks like an annotation file (YOLO/COCO labels). Use the Import button next to Upload — that's where label files go.",
    };
  }
  return {
    code: "ext-not-allowed",
    message: `Unsupported file type — this dialog uploads images & videos. Accepted: ${ALLOWED_UPLOAD_EXTENSIONS.join(", ")}`,
  };
}

// v2.6: cap retries so a sustained 429 doesn't loop forever.
const MAX_RETRIES = 3;
const FALLBACK_RETRY_AFTER_SECONDS = 60;

interface RateLimitedResponse {
  response?: {
    status?: number;
    data?: { error?: string; retry_after_seconds?: number };
    headers?: Record<string, string | undefined>;
  };
}

function extractRetryAfterSeconds(err: unknown): number | null {
  const e = err as RateLimitedResponse;
  if (e?.response?.status !== 429) return null;
  const fromBody = e.response?.data?.retry_after_seconds;
  if (typeof fromBody === "number" && fromBody > 0) return fromBody;
  const headerVal = e.response?.headers?.["retry-after"];
  if (headerVal) {
    const parsed = Number(headerVal);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return FALLBACK_RETRY_AFTER_SECONDS;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const VIDEO_RE = /\.(mp4|webm|mov)$/i;

interface UploadError {
  name: string;
  error: string;
}

type Phase =
  | { kind: "pick" }
  | {
      kind: "videoSetup";
      images: File[];
      videos: File[];
      strategy: ExtractStrategy;
    }
  | {
      kind: "uploading";
      images: File[];
      videos: File[];
      strategy: ExtractStrategy;
      done: number;
      total: number;
      errors: UploadError[];
      retryNotice: string | null;
    };

interface Props {
  projectId: string;
  taskId: string;
}

/**
 * v3.26 — phase-machine upload dialog.
 *
 * Replaces the broken two-dialog flow (upload then nested
 * FrameExtractDialog stacked on top) with a single inline state
 * machine: ``pick → videoSetup → uploading``. Detects videos at drop
 * time, asks once for a strategy, then uploads + kicks
 * ``/frames/extract`` per video and registers each as a ``frame-extract``
 * job in the BackgroundJobs store. The dialog auto-closes after the
 * upload pool drains and the BackgroundJobsBar takes over progress.
 */
export function AssetUploadDialog({ projectId: _projectId, taskId }: Props) {
  const qc = useQueryClient();
  const addJob = useBackgroundJobs((s) => s.add);
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });

  const onDrop = (files: File[]) => {
    if (files.length === 0) return;
    const videos = files.filter((f) => VIDEO_RE.test(f.name));
    const others = files.filter((f) => !VIDEO_RE.test(f.name));
    if (videos.length === 0) {
      void runUpload({
        images: others,
        videos: [],
        strategy: DEFAULT_EXTRACT_STRATEGY,
      });
      return;
    }
    setPhase({
      kind: "videoSetup",
      images: others,
      videos,
      strategy: DEFAULT_EXTRACT_STRATEGY,
    });
  };

  const runUpload = async (cfg: {
    images: File[];
    videos: File[];
    strategy: ExtractStrategy;
  }) => {
    const total = cfg.images.length + cfg.videos.length;
    setPhase({
      kind: "uploading",
      images: cfg.images,
      videos: cfg.videos,
      strategy: cfg.strategy,
      done: 0,
      total,
      errors: [],
      retryNotice: null,
    });

    const all = [...cfg.images, ...cfg.videos];
    const CONCURRENCY = 6;
    let cursor = 0;
    let count = 0;
    const errors: UploadError[] = [];

    const uploadOne = async (file: File): Promise<void> => {
      const isZip = file.name.toLowerCase().endsWith(".zip");
      const isVideo = VIDEO_RE.test(file.name);
      let attempt = 0;
      while (true) {
        try {
          if (isZip) {
            const created = await assetsApi.uploadZip(taskId, file);
            if (Array.isArray(created) && created.length === 0) {
              showToast(
                `"${file.name}" had no images inside. ` +
                  "If it's a YOLO/COCO label bundle, use the Import button instead.",
                { variant: "warning", duration: 7000 },
              );
            }
          } else {
            const asset = await assetsApi.upload(taskId, file);
            if (isVideo && asset?.id) {
              try {
                const needsN =
                  cfg.strategy.strategy === "every_nth" ||
                  cfg.strategy.strategy === "count";
                const { job_id } = await assetsApi.reextractFrames(asset.id, {
                  strategy: cfg.strategy.strategy,
                  n: needsN ? Math.max(1, cfg.strategy.n ?? 1) : null,
                  quality: cfg.strategy.quality,
                });
                addJob({
                  jobId: job_id,
                  taskId,
                  kind: "frame-extract",
                  label: `Extracting ${file.name}`,
                  startedAt: Date.now(),
                  assetId: asset.id,
                  cancel: async () => {},
                });
              } catch {
                errors.push({
                  name: file.name,
                  error: "extract_failed_open_re_extract_in_editor",
                });
              }
            }
          }
          return;
        } catch (err: unknown) {
          const retryAfterSec = extractRetryAfterSeconds(err);
          if (retryAfterSec !== null && attempt < MAX_RETRIES) {
            attempt += 1;
            setPhase((p) =>
              p.kind === "uploading"
                ? {
                    ...p,
                    retryNotice:
                      `Upload paused — server busy, retrying in ${retryAfterSec} seconds ` +
                      `(attempt ${attempt}/${MAX_RETRIES})…`,
                  }
                : p,
            );
            await sleep(retryAfterSec * 1000);
            continue;
          }
          throw err;
        }
      }
    };

    // Plan-20.11 — parallel upload pool.
    const worker = async () => {
      while (true) {
        const idx = cursor;
        cursor += 1;
        if (idx >= all.length) return;
        const file = all[idx];
        try {
          await uploadOne(file);
        } catch (err: unknown) {
          const code =
            (err as { response?: { data?: { error?: string } } })?.response
              ?.data?.error ?? "upload_failed";
          errors.push({ name: file.name, error: code });
        } finally {
          count += 1;
          setPhase((p) =>
            p.kind === "uploading"
              ? { ...p, done: count, errors: [...errors], retryNotice: null }
              : p,
          );
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, all.length) }, () => worker()),
    );

    qc.invalidateQueries({ queryKey: ["task-assets", taskId] });
    qc.invalidateQueries({ queryKey: ["task-assets-count", taskId] });

    if (errors.length === 0) {
      showToast(
        cfg.videos.length > 0
          ? `Uploaded ${total} files; extracting frames in background.`
          : `Uploaded ${total} files.`,
        { variant: "success" },
      );
      // Auto-close only on clean upload — otherwise leave the dialog in
      // its "uploading" phase so the user can read the per-file errors.
      setTimeout(() => setPhase({ kind: "pick" }), 1000);
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    validator: validateExtension,
    onDrop,
    onDropRejected: (rejections: FileRejection[]) => {
      showToast(
        rejections.length === 1
          ? `Couldn't accept "${rejections[0].file.name}" — ${rejections[0].errors[0]?.message ?? ""}`
          : `${rejections.length} files were rejected — see the dialog for details.`,
        { variant: "error", duration: 6000 },
      );
    },
  });

  return (
    <section className="grid gap-3" data-testid="asset-upload-dialog">
      <h2 className="text-[18px] font-light tracking-tight text-primary">
        Upload assets
      </h2>

      {phase.kind === "pick" && (
        <div
          {...getRootProps()}
          className={cn(
            "grid place-items-center gap-2 px-6 py-10 cursor-pointer transition-all",
            "rounded-[var(--radius-lg)] border-2 border-dashed",
            isDragActive
              ? "border-[var(--border-accent)] bg-[var(--accent-bg)]"
              : "border-[var(--border-subtle)] bg-[oklch(0.18_0.012_240_/_0.30)] hover:border-[var(--border-strong)]",
          )}
        >
          <input {...getInputProps()} aria-label="upload-input" />
          <FileImage
            className={cn(
              "h-7 w-7 transition-colors",
              isDragActive ? "text-[color:var(--accent)]" : "text-tertiary",
            )}
          />
          <p className="text-[13px] text-secondary tracking-tight text-center">
            {isDragActive
              ? "Drop to upload"
              : "Drag & drop images, videos, or .zip — or click to choose"}
          </p>
        </div>
      )}

      {phase.kind === "videoSetup" && (
        <div className="grid gap-3">
          <VideoExtractPanel
            videoCount={phase.videos.length}
            value={phase.strategy}
            onChange={(next) =>
              setPhase((p) =>
                p.kind === "videoSetup" ? { ...p, strategy: next } : p,
              )
            }
          />
          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              size="md"
              data-testid="upload-back"
              leftIcon={<ArrowLeft className="h-3.5 w-3.5" />}
              onClick={() => setPhase({ kind: "pick" })}
            >
              Back
            </Button>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="md"
                data-testid="upload-cancel"
                onClick={() => setPhase({ kind: "pick" })}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="md"
                data-testid="upload-continue"
                onClick={() =>
                  void runUpload({
                    images: phase.images,
                    videos: phase.videos,
                    strategy: phase.strategy,
                  })
                }
              >
                Continue
              </Button>
            </div>
          </div>
        </div>
      )}

      {phase.kind === "uploading" && (
        <>
          <p className="flex items-center gap-2 text-tertiary text-[12px]">
            <Upload className="h-3.5 w-3.5 animate-pulse text-[color:var(--accent)]" />
            Uploaded {phase.done} / {phase.total}
          </p>
          {phase.retryNotice && (
            <p
              role="status"
              aria-live="polite"
              className="flex items-center gap-2 text-[color:var(--warning,oklch(0.78_0.18_85))] text-[12px]"
            >
              <Upload className="h-3.5 w-3.5 animate-pulse" />
              {phase.retryNotice}
            </p>
          )}
          {phase.errors.length > 0 && (
            <ul role="alert" className="grid gap-1 text-[color:var(--danger)] text-[12px]">
              {phase.errors.map((e, i) => (
                <li key={i}>
                  <span className="font-mono-data text-tertiary mr-2">{e.name}:</span>
                  {e.error}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
