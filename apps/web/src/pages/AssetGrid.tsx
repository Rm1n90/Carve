import { useQuery } from "@tanstack/react-query";
import { assetsApi, type Asset } from "@/api/assets";

function AssetTile({ asset }: { asset: Asset }) {
  // Lazy-fetch presigned URL only when this tile mounts
  const q = useQuery({
    queryKey: ["asset", asset.id],
    queryFn: () => assetsApi.get(asset.id),
    staleTime: 5 * 60 * 1000,
  });
  return (
    <div
      style={{
        position: "relative",
        aspectRatio: "1",
        borderRadius: 8,
        overflow: "hidden",
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.1)",
      }}
    >
      {asset.kind === "image" && q.data && (
        <img
          src={q.data.url}
          alt={asset.original_name}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      )}
      {asset.kind === "video" && (
        <div style={{ display: "grid", placeItems: "center", height: "100%", fontSize: 24 }}>
          🎬
        </div>
      )}
      <div
        style={{
          position: "absolute",
          left: 6,
          bottom: 6,
          fontSize: 11,
          background: "rgba(0,0,0,0.6)",
          padding: "2px 6px",
          borderRadius: 4,
        }}
      >
        {asset.original_name}
      </div>
    </div>
  );
}

export function AssetGrid({ taskId }: { taskId: string }) {
  const q = useQuery({
    queryKey: ["assets", taskId],
    queryFn: () => assetsApi.listForTask(taskId),
  });
  if (q.isLoading) return <p>Loading…</p>;
  if (q.error) return <p style={{ color: "tomato" }}>Failed to load assets.</p>;
  if (!q.data || q.data.length === 0) {
    return <p style={{ opacity: 0.6, fontSize: 13 }}>No assets yet — drop some files above.</p>;
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
        gap: 12,
      }}
    >
      {q.data.map((a) => (
        <AssetTile key={a.id} asset={a} />
      ))}
    </div>
  );
}
