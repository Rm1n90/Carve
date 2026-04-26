import { useAnnotations } from "@/state/annotations";

export function ObjectsPanel({ frameId }: { frameId: string | null }) {
  const byId = useAnnotations((s) => s.byId);
  const selectedId = useAnnotations((s) => s.selectedId);
  const select = useAnnotations((s) => s.select);
  const remove = useAnnotations((s) => s.remove);

  const items = Object.values(byId)
    .filter((a) => a.frameId === frameId)
    .sort((a, b) => a.tempId.localeCompare(b.tempId));

  return (
    <section aria-label="Objects on this frame" style={{ display: "grid", gap: 6 }}>
      <h3 style={{ margin: 0, fontSize: 13, opacity: 0.7 }}>Objects</h3>
      {items.length === 0 && (
        <p style={{ opacity: 0.5, fontSize: 12 }}>No annotations yet on this frame.</p>
      )}
      <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 4 }}>
        {items.map((a) => (
          <li
            key={a.tempId}
            onClick={() => select(a.tempId)}
            style={{
              padding: "6px 8px",
              borderRadius: 6,
              background: a.tempId === selectedId
                ? "rgba(120,200,255,0.18)"
                : "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.08)",
              cursor: "pointer",
              display: "flex",
              gap: 8,
              alignItems: "center",
            }}
          >
            <span aria-label={`${a.kind} icon`} style={{ width: 16, opacity: 0.7 }}>
              {a.kind === "bbox" && "▭"}
              {a.kind === "polygon" && "⬟"}
              {a.kind === "mask" && "▦"}
              {a.kind === "tag" && "#"}
            </span>
            <span style={{ flex: 1, fontSize: 12, opacity: 0.85 }}>{a.kind}</span>
            <button
              aria-label={`Delete ${a.kind}`}
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Delete this ${a.kind}?`)) remove(a.tempId);
              }}
              style={{ fontSize: 11 }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
