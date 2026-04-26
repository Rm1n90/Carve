import { useEffect } from "react";
import type { ClassRow } from "@/api/classes";
import { useTool } from "@/state/tool";

interface Props {
  classes: ClassRow[];
}

export function ClassesPanel({ classes }: Props) {
  const activeClassId = useTool((s) => s.activeClassId);
  const setActiveClassId = useTool((s) => s.setActiveClassId);

  // 1-9 hotkeys
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const n = parseInt(e.key, 10);
      if (Number.isInteger(n) && n >= 1 && n <= 9) {
        const target = classes[n - 1];
        if (target) setActiveClassId(target.id);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [classes, setActiveClassId]);

  return (
    <section aria-label="Classes" style={{ display: "grid", gap: 6 }}>
      <h3 style={{ margin: 0, fontSize: 13, opacity: 0.7 }}>Classes</h3>
      {classes.length === 0 && (
        <p style={{ opacity: 0.5, fontSize: 12 }}>No classes defined.</p>
      )}
      <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 4 }}>
        {classes.map((c, i) => (
          <li
            key={c.id}
            onClick={() => setActiveClassId(c.id)}
            style={{
              padding: "6px 8px",
              borderRadius: 6,
              background: c.id === activeClassId
                ? "rgba(120,200,255,0.18)"
                : "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.08)",
              cursor: "pointer",
              display: "flex",
              gap: 8,
              alignItems: "center",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 16,
                height: 16,
                background: c.color,
                borderRadius: 4,
                border: "1px solid rgba(255,255,255,0.2)",
              }}
            />
            <span style={{ flex: 1, fontSize: 12 }}>{c.name}</span>
            {i < 9 && (
              <span
                style={{
                  fontSize: 10,
                  padding: "1px 5px",
                  borderRadius: 4,
                  background: "rgba(255,255,255,0.08)",
                  opacity: 0.6,
                }}
              >
                {i + 1}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
