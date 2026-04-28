import { useState } from "react";
import { useDropzone } from "react-dropzone";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Upload, FileImage } from "lucide-react";
import { assetsApi } from "@/api/assets";
import { cn } from "@/lib/cn";

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

  const uploadOne = async (file: File): Promise<void> => {
    const send = () =>
      file.name.toLowerCase().endsWith(".zip")
        ? assetsApi.uploadZip(taskId, file)
        : assetsApi.upload(taskId, file);

    let attempt = 0;
    // Loop bound: initial attempt + up to MAX_RETRIES retries.
    while (true) {
      try {
        await send();
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
      let count = 0;
      for (const file of files) {
        try {
          await uploadOne(file);
        } catch (err: unknown) {
          const code =
            (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
            "upload_failed";
          setErrors((p) => [...p, { name: file.name, error: code }]);
        } finally {
          count += 1;
          setDone(count);
        }
      }
      setRetryNotice(null);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["assets", taskId] }),
  });

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: {
      "image/png": [".png"],
      "image/jpeg": [".jpg", ".jpeg"],
      "image/webp": [".webp"],
      "video/mp4": [".mp4"],
      "video/webm": [".webm"],
      "video/quicktime": [".mov"],
      "application/zip": [".zip"],
    },
    onDrop: (files) => upload.mutate(files),
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
    </section>
  );
}
