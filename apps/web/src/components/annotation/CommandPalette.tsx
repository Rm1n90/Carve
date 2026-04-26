import { useEffect, useMemo, useState } from "react";
import type { ClassRow } from "@/api/classes";
import { useTool } from "@/state/tool";

interface Props {
  classes: ClassRow[];
  onSaveNow: () => void;
}

export function CommandPalette({ classes, onSaveNow }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const setActiveClassId = useTool((s) => s.setActiveClassId);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const items = useMemo(() => {
    const q = query.toLowerCase();
    const fromClasses = classes
      .filter((c) => c.name.toLowerCase().includes(q))
      .map((c) => ({
        id: `class-${c.id}`,
        label: `Switch class → ${c.name}`,
        run: () => setActiveClassId(c.id),
      }));
    const builtins = [
      {
        id: "save-now",
        label: "Save now (Cmd+S)",
        run: onSaveNow,
      },
    ].filter((b) => b.label.toLowerCase().includes(q));
    return [...builtins, ...fromClasses];
  }, [classes, query, setActiveClassId, onSaveNow]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-label="Command palette"
      style={{
        position: "fixed",
        top: "10vh",
        left: "50%",
        transform: "translateX(-50%)",
        width: 480,
        maxWidth: "90vw",
        zIndex: 1000,
        background: "rgba(20,20,30,0.96)",
        border: "1px solid rgba(255,255,255,0.15)",
        borderRadius: 10,
        padding: 12,
        boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        autoFocus
        aria-label="command-palette-input"
        placeholder="Type a class name or 'save'…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && items[0]) {
            items[0].run();
            setOpen(false);
            setQuery("");
          }
        }}
        style={{
          width: "100%",
          padding: "8px 10px",
          borderRadius: 6,
          border: "1px solid rgba(255,255,255,0.15)",
          background: "transparent",
          color: "inherit",
          fontSize: 14,
        }}
      />
      <ul
        style={{ listStyle: "none", padding: 0, margin: "8px 0 0 0", maxHeight: 320, overflow: "auto" }}
      >
        {items.slice(0, 50).map((it) => (
          <li
            key={it.id}
            onClick={() => {
              it.run();
              setOpen(false);
              setQuery("");
            }}
            style={{
              padding: "6px 8px",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            {it.label}
          </li>
        ))}
        {items.length === 0 && (
          <li style={{ padding: "6px 8px", opacity: 0.5, fontSize: 13 }}>No matches.</li>
        )}
      </ul>
    </div>
  );
}
