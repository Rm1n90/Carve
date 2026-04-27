import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { assetsApi, type Asset } from "@/api/assets";
import { cn } from "@/lib/cn";

interface Props {
  taskId: string;
  projectId: string;
  activeAssetId: string;
}

const MAX_THUMBS = 50;

function ThumbItem({
  asset,
  projectId,
  taskId,
  active,
}: {
  asset: Asset;
  projectId: string;
  taskId: string;
  active: boolean;
}) {
  const q = useQuery({
    queryKey: ["asset", asset.id],
    queryFn: () => assetsApi.get(asset.id),
    staleTime: 60_000,
  });

  const url = q.data?.url;

  return (
    <Link
      to="/projects/$projectId/tasks/$taskId/assets/$assetId"
      params={{ projectId, taskId, assetId: asset.id }}
      className={cn(
        "shrink-0 block h-[56px] w-[80px] rounded-[var(--radius-sm)] border overflow-hidden",
        "bg-[var(--bg-subtle)] transition-all duration-150",
        active
          ? "border-[var(--accent)] outline-2 outline-offset-1 outline-[var(--accent)]"
          : "border-[var(--border-subtle)] hover:border-[var(--border-strong)]",
      )}
      aria-label={`Open ${asset.original_name}`}
      data-testid={`thumb-${asset.id}`}
      data-active={active ? "true" : undefined}
    >
      {url ? (
        <img
          src={url}
          alt={asset.original_name}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="block h-full w-full" aria-hidden />
      )}
    </Link>
  );
}

export function AssetThumbnailStrip({ taskId, projectId, activeAssetId }: Props) {
  const q = useQuery({
    queryKey: ["task-assets", taskId],
    queryFn: () => assetsApi.listForTask(taskId),
  });
  const assets = (q.data ?? []).slice(-MAX_THUMBS);
  if (assets.length <= 1) return null;
  return (
    <div
      role="region"
      aria-label="Task thumbnails"
      data-testid="asset-thumbnail-strip"
      className={cn(
        "h-[64px] shrink-0 border-b border-[var(--border-subtle)]",
        "bg-[var(--bg-app)] flex items-center gap-2 px-3 overflow-x-auto",
      )}
    >
      {assets.map((a) => (
        <ThumbItem
          key={a.id}
          asset={a}
          projectId={projectId}
          taskId={taskId}
          active={a.id === activeAssetId}
        />
      ))}
    </div>
  );
}
