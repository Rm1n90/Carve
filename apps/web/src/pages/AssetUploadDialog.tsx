// Armin Mehri — mehri.armin@gmail.com
import { useState } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Upload, FileImage } from "lucide-react";
import { assetsApi } from "@/api/assets";
import { FrameExtractDialog } from "@/components/annotation/FrameExtractDialog";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/cn";

// Plan-20.7 — accept by extension. The previous MIME-keyed
// react-dropzone config silently rejected any ZIP whose MIME wasn't
// exactly ``application/zip`` (Windows often reports
// ``application/x-zip-compressed``, some browsers report empty), and
// the rejected files never reached ``onDrop``. The dialog then ran an
// empty loop and showed "Uploaded 0 files" before vanishing.
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

// Plan-20.8 — annotation file extensions get a SPECIFIC rejection
// message that points the user at the Import button. The previous
// generic "Unsupported file type" was useless when the user
// accidentally tried to upload labels via this dialog.
const ANNOTATION_EXTENSIONS = [".txt", ".yaml", ".yml", ".json"];

function validateExtension(file: File) {
  const lower = file.name.toLowerCase();
  if (ALLOWED_UPLOAD_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return null;
  }
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

interface Props {
  projectId: string;
  taskId: string;
}

// v2.6: cap retries so a sustained 429 doesn't loop forever. The API
// allows 1000 single-asset uploads per minute, so a real user will
// almost never hit a 429 — but if they do, we wait the server-supplied
// Retry-After window and retry up to MAX_RETRIES times.
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

export function AssetUploadDialog({ projectId: _projectId, taskId }: Props) {
  const qc = useQueryClient();
  const [errors, setErrors] = useState<{ name: string; error: string }[]>([]);
  const [done, setDone] = useState<number>(0);
  // Surfaces "Upload paused — server busy, retrying in N seconds" to the
  // user without losing per-file error rendering. Cleared once the retry
  // succeeds or the file is given up on after MAX_RETRIES.
  const [retryNotice, setRetryNotice] = useState<string | null>(null);

  // v3.8 Phase 4-video step E — track uploaded video asset ids so the
  // post-upload dialog can offer a per-video frame-extraction strategy.
  const [pendingVideoIds, setPendingVideoIds] = useState<string[]>([]);
  const [extractDialogOpen, setExtractDialogOpen] = useState(false);

  const uploadOne = async (file: File): Promise<void> => {
    const isZip = file.name.toLowerCase().endsWith(".zip");
    const isVideo = /\.(mp4|webm|mov)$/i.test(file.name);

    let attempt = 0;
    while (true) {
      try {
        if (isZip) {
          // Plan-20.8 — if the ZIP yielded zero new assets the user
          // probably zipped label files instead of images. Tell them
          // exactly what to do instead of silently succeeding.
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
            setPendingVideoIds((prev) => [...prev, asset.id]);
          }
        }
        setRetryNotice(null);
        return;
      } catch (err: unknown) {
        const retryAfterSec = extractRetryAfterSeconds(err);
        if (retryAfterSec !== null && attempt < MAX_RETRIES) {
          attempt += 1;
          setRetryNotice(
            `Upload paused — server busy, retrying in ${retryAfterSec} seconds (attempt ${attempt}/${MAX_RETRIES})…`,
          );
          await sleep(retryAfterSec * 1000);
          continue;
        }
        throw err;
      }
    }
  };

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      setErrors([]);
      setDone(0);
      setRetryNotice(null);
      // Plan-20.11 — parallel upload pool. Sequential awaiting was the
      // dominant cost on 1000+ image drops; with 200–300 ms RTT per
      // request the browser was busy for ~10 min and the nginx
      // proxy_read_timeout fired before the loop finished. Six
      // concurrent uploads saturate HTTP/2 multiplexing without
      // overwhelming the browser's per-host queue. Each completed
      // file ticks ``done`` so the progress indicator stays live.
      const CONCURRENCY = 6;
      let count = 0;
      let cursor = 0;
      const worker = async () => {
        while (true) {
          const idx = cursor;
          cursor += 1;
          if (idx >= files.length) return;
          const file = files[idx];
          try {
            await uploadOne(file);
          } catch (err: unknown) {
            const code =
              (err as { response?: { data?: { error?: string } } })?.response?.data
                ?.error ?? "upload_failed";
            setErrors((p) => [...p, { name: file.name, error: code }]);
          } finally {
            count += 1;
            setDone(count);
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, files.length) }, () =>
          worker(),
        ),
      );
      setRetryNotice(null);
    },
    // v3.7 Issue 5: previously invalidated ["assets", taskId] which no
    // consumer actually uses. The grid + count + thumbnail strip key on
    // ["task-assets", ...] / ["task-assets-count", ...]. Without these
    // refreshes the user had to manually reload to see new uploads.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["task-assets", taskId] });
      qc.invalidateQueries({ queryKey: ["task-assets-count", taskId] });
      // v3.8 Phase 4-video step E — if any videos were uploaded, ask
      // the user how many frames to extract. Auto extraction kicks in
      // by default at upload (worker tail in jobs/thumbs.py); the
      // dialog lets them override before that finishes (or refines
      // afterwards via the same workflow).
      setPendingVideoIds((ids) => {
        if (ids.length > 0) setExtractDialogOpen(true);
        return ids;
      });
    },
  });

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    // Plan-20.7 — extension-based validation instead of MIME keys so
    // ZIPs with non-standard MIME types (Windows
    // 'application/x-zip-compressed', empty MIME from drag-n-drop)
    // still pass the filter. The fallback file-picker accept attr is
    // a hint to the OS dialog only.
    validator: validateExtension,
    onDrop: (files) => {
      if (files.length === 0) return;
      upload.mutate(files);
    },
    onDropRejected: (rejections: FileRejection[]) => {
      const rows = rejections.map((r) => ({
        name: r.file.name,
        error:
          r.errors[0]?.message ?? "Unsupported file (couldn't determine why)",
      }));
      setErrors((prev) => [...prev, ...rows]);
      showToast(
        rejections.length === 1
          ? `Couldn't accept "${rejections[0].file.name}" — ${rows[0].error}`
          : `${rejections.length} files were rejected — see the dialog for details.`,
        { variant: "error", duration: 6000 },
      );
    },
  });

  return (
    <section className="grid gap-3">
      <h2 className="text-[18px] font-medium tracking-tight text-primary">Upload assets</h2>
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
      {upload.isPending && (
        <p className="flex items-center gap-2 text-tertiary text-[12px]">
          <Upload className="h-3.5 w-3.5 animate-pulse text-[color:var(--accent)]" />
          Uploaded {done} files…
        </p>
      )}
      {retryNotice && (
        <p
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 text-[color:var(--warning,oklch(0.78_0.18_85))] text-[12px]"
        >
          <Upload className="h-3.5 w-3.5 animate-pulse" />
          {retryNotice}
        </p>
      )}
      {errors.length > 0 && (
        <ul role="alert" className="grid gap-1 text-[color:var(--danger)] text-[12px]">
          {errors.map((e, i) => (
            <li key={i}>
              <span className="font-mono-data text-tertiary mr-2">{e.name}:</span>
              {e.error}
            </li>
          ))}
        </ul>
      )}
      {/* v3.8 Phase 4-video step E — post-upload strategy picker for
          videos. Controlled-open so we trigger it programmatically; on
          submit, applies the chosen strategy to every uploaded video. */}
      {pendingVideoIds.length > 0 && (
        <FrameExtractDialog
          open={extractDialogOpen}
          onOpenChange={(o) => {
            setExtractDialogOpen(o);
            if (!o) setPendingVideoIds([]);
          }}
          onSubmit={async (body) => {
            try {
              await Promise.all(
                pendingVideoIds.map((id) =>
                  assetsApi.reextractFrames(id, body),
                ),
              );
              showToast(
                `Extracting frames for ${pendingVideoIds.length} video${pendingVideoIds.length === 1 ? "" : "s"}…`,
                { variant: "success" },
              );
            } catch {
              showToast("Failed to start frame extraction.", {
                variant: "error",
              });
            }
            setPendingVideoIds([]);
            setExtractDialogOpen(false);
          }}
        />
      )}
    </section>
  );
}
