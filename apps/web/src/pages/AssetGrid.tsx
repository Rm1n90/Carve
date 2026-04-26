import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Video } from "lucide-react";
import { assetsApi, type Asset } from "@/api/assets";
import { cn } from "@/lib/cn";

function AssetTile({
  asset,
  projectId,
  taskId,
}: {
  asset: Asset;
  projectId: string;
  taskId: string;
}) {
  const q = useQuery({
    queryKey: ["asset", asset.id],
    queryFn: () => assetsApi.get(asset.id),
    staleTime: 5 * 60 * 1000,
  });
  return (
    <Link
      to="/projects/$projectId/tasks/$taskId/assets/$assetId"
      params={{ projectId, taskId, assetId: asset.id }}
      className="group block"
    >
      <div
        className={cn(
          "relative aspect-square overflow-hidden",
          "rounded-[var(--radius-md)] border border-[var(--border-subtle)]",
          "bg-[var(--bg-sunken)]",
          "transition-all duration-200",
          "group-hover:border-[var(--border-accent)] group-hover:shadow-[0_0_24px_oklch(0.78_0.16_215_/_0.18)]",
        )}
      >
        {asset.kind === "image" && q.data && (
          <img
            src={q.data.url}
            alt={asset.original_name}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        )}
        {asset.kind === "video" && (
          <div className="grid h-full place-items-center text-[var(--accent)]">
            <Video className="h-8 w-8" />
          </div>
        )}
        <div className="absolute inset-x-2 bottom-2 px-2 py-1 rounded-[var(--radius-xs)] bg-[oklch(0.06_0.012_240_/_0.7)] backdrop-blur-md text-[11px] text-secondary truncate">
          {asset.original_name}
        </div>
      </div>
    </Link>
  );
}

export function AssetGrid({ projectId, taskId }: { projectId: string; taskId: string }) {
  const q = useQuery({
    queryKey: ["assets", taskId],
    queryFn: () => assetsApi.listForTask(taskId),
  });
  if (q.isLoading) return <p className="text-tertiary text-[13px]">Loading…</p>;
  if (q.error) return <p className="text-[var(--danger)] text-[13px]">Failed to load assets.</p>;
  if (!q.data || q.data.length === 0) {
    return (
      <p className="text-tertiary text-[13px] italic">No assets yet — drop some files above.</p>
    );
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
      {q.data.map((a) => (
        <AssetTile key={a.id} asset={a} projectId={projectId} taskId={taskId} />
      ))}
    </div>
  );
}
