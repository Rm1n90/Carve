import { useEffect } from "react";
import { useTool, type ToolName } from "@/state/tool";

interface ToolDef {
  name: ToolName;
  label: string;
  hotkey: string;
  icon: string;
}

const TOOLS: ToolDef[] = [
  { name: "cursor", label: "Cursor", hotkey: "V", icon: "↖" },
  { name: "bbox", label: "Bounding box", hotkey: "B", icon: "▭" },
  { name: "polygon", label: "Polygon", hotkey: "P", icon: "⬟" },
  { name: "mask", label: "Mask brush", hotkey: "M", icon: "✎" },
  { name: "tag", label: "Tag", hotkey: "T", icon: "#" },
  { name: "sam", label: "Magic wand (SAM)", hotkey: "S", icon: "✨" },
];


export function Toolbar() {
  const active = useTool((s) => s.active);
  const setActive = useTool((s) => s.setActive);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      // Skip when typing in an input
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const match = TOOLS.find((tool) => tool.hotkey.toLowerCase() === e.key.toLowerCase());
      if (match) {
        setActive(match.name);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setActive]);

  return (
    <aside
      role="toolbar"
      aria-label="Annotation tools"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: 8,
        borderRight: "1px solid rgba(255,255,255,0.1)",
        width: 56,
      }}
    >
      {TOOLS.map((t) => (
        <button
          key={t.name}
          aria-label={`${t.label} (${t.hotkey})`}
          aria-pressed={active === t.name}
          onClick={() => setActive(t.name)}
          title={`${t.label} — ${t.hotkey}`}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 40,
            height: 40,
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.1)",
            background: active === t.name
              ? "rgba(120,200,255,0.18)"
              : "rgba(255,255,255,0.04)",
            color: "inherit",
            cursor: "pointer",
            fontSize: 18,
          }}
        >
          {t.icon}
        </button>
      ))}
    </aside>
  );
}
