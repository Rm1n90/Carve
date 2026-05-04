// Armin Mehri — mehri.armin@gmail.com
//
// Plan-18 — Classification chip strip.
//
// Renders at the top of the Classes panel. Each project class becomes
// a clickable chip; click toggles a tag annotation for the current
// frame. Works in any editor tool — no need to switch to the Tag (T)
// tool first.
//
// Visual states:
//   - filled chip with class colour    → frame is tagged with this class
//   - outline chip                      → not tagged
//
// Multi-label by design: clicking another chip adds, clicking a
// filled chip removes. (classId, frameId) is the natural key for the
// tag annotation, mirrored on the server via the existing batch save.
import { Tag } from "lucide-react";
import { useMemo } from "react";
import type { ClassRow } from "@/api/classes";
import { useAnnotations } from "@/state/annotations";
import { cn } from "@/lib/cn";

interface ClassificationStripProps {
  classes: ClassRow[];
  /** ``null`` for image tasks where the auto-frame is not yet known.
   *  Tag toggles are no-ops in that state. */
  frameId: string | null;
}

export function ClassificationStrip({
  classes,
  frameId,
}: ClassificationStripProps) {
  // Subscribe to a derived map {classId → existing tag tempId} for the
  // current frame. The selector returns a fresh object on every store
  // change; React's shallow equality check would re-render the entire
  // strip every time, which is fine for ≤50 classes (the chips are
  // cheap). For 100+ classes consider memoising upstream.
  const tagsByClass = useAnnotations((s) => {
    const map: Record<string, string> = {};
    for (const ann of Object.values(s.byId)) {
      if (ann.kind === "tag" && ann.frameId === frameId) {
        map[ann.classId] = ann.tempId;
      }
    }
    return map;
  });

  const sorted = useMemo(
    () => [...classes].sort((a, b) => a.idx - b.idx),
    [classes],
  );

  function toggle(classId: string) {
    const existingTempId = tagsByClass[classId];
    if (existingTempId) {
      useAnnotations.getState().remove(existingTempId);
      return;
    }
    useAnnotations.getState().add({
      tempId: `t-${Date.now().toString(36)}-${classId.slice(0, 6)}`,
      classId,
      kind: "tag",
      geometry: { kind: "tag" },
      frameId,
      serverId: null,
      dirty: true,
    });
  }

  if (sorted.length === 0) return null;

  const tagCount = Object.keys(tagsByClass).length;

  return (
    <section
      data-testid="classification-strip"
      aria-label="Classify this image"
      className="grid gap-1.5 px-2 pt-2 pb-2 border-b border-[var(--border-subtle)]"
    >
      <header className="flex items-center justify-between text-[10.5px] uppercase tracking-[0.08em] text-[color:var(--text-tertiary)]">
        <span className="inline-flex items-center gap-1">
          <Tag className="h-3 w-3" aria-hidden />
          Classify
        </span>
        <span className="font-mono tabular-nums">
          {tagCount > 0 ? `${tagCount} tagged` : "no tags"}
        </span>
      </header>
      <div role="list" className="flex flex-wrap gap-1">
        {sorted.map((cls) => {
          const isTagged = !!tagsByClass[cls.id];
          return (
            <button
              key={cls.id}
              type="button"
              role="listitem"
              data-testid={`classify-chip-${cls.id}`}
              data-tagged={isTagged ? "true" : undefined}
              onClick={() => toggle(cls.id)}
              title={
                isTagged
                  ? `Remove "${cls.name}" tag from this frame`
                  : `Tag this frame as "${cls.name}"`
              }
              className={cn(
                "inline-flex items-center gap-1.5 h-7 px-2 rounded-full text-[11.5px] tracking-tight",
                "transition-[background-color,color,border-color,transform] active:scale-[0.97]",
                "border",
                isTagged
                  ? "text-white border-transparent shadow-sm"
                  : "border-[var(--border-strong)] text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)] hover:border-[var(--text-primary)]",
              )}
              style={
                isTagged
                  ? { background: cls.color, borderColor: cls.color }
                  : undefined
              }
            >
              <span
                aria-hidden
                className={cn(
                  "h-2.5 w-2.5 rounded-full shrink-0",
                  isTagged ? "bg-white/70" : "",
                )}
                style={isTagged ? undefined : { background: cls.color }}
              />
              <span className="truncate max-w-[140px]">{cls.name}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
