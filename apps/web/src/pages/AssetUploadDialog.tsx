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

export function AssetUploadDialog({ projectId: _projectId, taskId }: Props) {
  const qc = useQueryClient();
  const [errors, setErrors] = useState<{ name: string; error: string }[]>([]);
  const [done, setDone] = useState<number>(0);

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      setErrors([]);
      setDone(0);
      let count = 0;
      for (const file of files) {
        try {
          if (file.name.toLowerCase().endsWith(".zip")) {
            await assetsApi.uploadZip(taskId, file);
          } else {
            await assetsApi.upload(taskId, file);
          }
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
            isDragActive ? "text-[var(--accent)]" : "text-tertiary",
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
          <Upload className="h-3.5 w-3.5 animate-pulse text-[var(--accent)]" />
          Uploaded {done} files…
        </p>
      )}
      {errors.length > 0 && (
        <ul role="alert" className="grid gap-1 text-[var(--danger)] text-[12px]">
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
