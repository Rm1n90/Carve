import { useState } from "react";
import { useDropzone } from "react-dropzone";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { assetsApi } from "@/api/assets";

interface Props {
  projectId: string;
  taskId: string;
}

export function AssetUploadDialog({ projectId, taskId }: Props) {
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
    <section style={{ display: "grid", gap: 8 }}>
      <h2 style={{ margin: 0 }}>Upload assets</h2>
      <div
        {...getRootProps()}
        style={{
          padding: 24,
          border: `2px dashed ${isDragActive ? "rgba(120, 200, 255, 0.6)" : "rgba(255,255,255,0.2)"}`,
          borderRadius: 10,
          textAlign: "center",
          cursor: "pointer",
          background: isDragActive ? "rgba(120,200,255,0.05)" : undefined,
        }}
      >
        <input {...getInputProps()} aria-label="upload-input" />
        <p style={{ margin: 0 }}>
          {isDragActive ? "Drop to upload" : "Drag & drop images, videos, or .zip — or click to choose"}
        </p>
      </div>
      {upload.isPending && (
        <p style={{ opacity: 0.7, fontSize: 13 }}>Uploaded {done} files…</p>
      )}
      {errors.length > 0 && (
        <ul role="alert" style={{ color: "tomato", fontSize: 13 }}>
          {errors.map((e, i) => (
            <li key={i}>{e.name}: {e.error}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
