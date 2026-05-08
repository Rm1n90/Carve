// Armin Mehri — mehri.armin@gmail.com
/**
 * VisualReferencePicker — shared by YoloeDialog (Smart Find) and
 * AutoAnnotateDialog (SAM Visual Prompt tab).
 *
 * Controlled component: parent owns the picks map. Optional refKindFilter
 * restricts the visible refs to one geometry kind (used by SAM, where
 * each run is single-kind).
 *
 * Pick objects carry the original geometry (bbox xyxy OR polygon points)
 * so consumers that want polygon-aware backends (e.g. SAM 3.1 PCS) can
 * use it directly. YOLOE uses the same payload but flattens polygon →
 * enclosing bbox at wire-build time.
 */
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2, Wand2 } from "lucide-react";

import type { ClassRow } from "@/api/classes";
import type { Asset } from "@/api/assets";
import type { AnnotationDraft } from "@/state/annotations";
import { cn } from "@/lib/cn";

export type VisualPick = {
  assetId: string;
  annotationId: string;
  classId: string;
  className: string;
  color: string;
  sourceKind: "bbox" | "polygon";
  geometry:
    | { kind: "bbox"; xyxy: [number, number, number, number] }
    | { kind: "polygon"; points: [number, number][] };
};

export interface RawRef {
  id: string;
  classId: string;
  kind: "bbox" | "polygon";
  geometry: Record<string, unknown>;
}

export interface VisualReference {
  /** Source annotation id — used as the React key. */
  id: string;
  /** Source kind label for the chip ("bbox" or "polygon"). */
  sourceKind: "bbox" | "polygon";
  /** xyxy in image-space pixels. Polygons are converted to enclosing bbox. */
  xyxy: [number, number, number, number];
  /** Original geometry preserved so SAM consumers can use polygon points. */
  geometry:
    | { kind: "bbox"; xyxy: [number, number, number, number] }
    | { kind: "polygon"; points: [number, number][] };
  /** Project class name attached to the source annotation, or "<unmapped>". */
  className: string;
  /** Project class id of the source annotation (used as the default
   *  "annotate matches as" pick when the user toggles the ref). */
  sourceClassId: string;
  /** Project class color (CSS color string), or a neutral fallback. */
  color: string;
}

export interface VisualReferencePickerProps {
  /** The asset currently open in the editor. Used as fallback for the
   *  active source asset id and to decide whether to read live drafts
   *  from annotationsById. */
  assetId: string | null;
  /** Optional task id (passed by parent for query keying / loading
   *  state hints — not used directly by this component). */
  taskId?: string;
  /** All classes in the project — used for color/name lookup. */
  classes: ClassRow[];
  /** Pickable source assets (image-only, must have at least one
   *  bbox/polygon). The parent computes this from the task fetch. */
  pickableAssets: Asset[];
  /** Map from source asset id → list of bbox/polygon refs. Parent owns
   *  the task-wide annotations fetch. */
  annotationsByAssetId: Map<string, RawRef[]>;
  /** Live editor store (current asset only) — keyed by tempId. Used so
   *  the user's unsaved draws show up immediately. */
  annotationsById: Record<string, AnnotationDraft>;
  /** Picks map (controlled). Key = `${assetId}:${annotationId}`. */
  picks: Record<string, VisualPick>;
  /** Called whenever the picks map changes. */
  onPicksChange: (next: Record<string, VisualPick>) => void;
  /** When set, hide refs whose kind ≠ the filter. SAM uses this to keep
   *  each run single-kind. */
  refKindFilter?: "bbox" | "polygon";
  /** True when the parent is still loading task assets / annotations.
   *  Drives the loading skeleton. */
  loading?: boolean;
  /** Optional override for the active source asset id (controlled). */
  activeSourceAssetId?: string | null;
  onActiveSourceAssetIdChange?: (id: string | null) => void;
}

export function pickKey(srcAssetId: string, refId: string): string {
  return `${srcAssetId}:${refId}`;
}

function geometryToXyxy(
  geom: AnnotationDraft["geometry"],
): [number, number, number, number] | null {
  if (geom.kind === "bbox") {
    return [geom.x, geom.y, geom.x + geom.w, geom.y + geom.h];
  }
  if (geom.kind === "polygon" && geom.points.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of geom.points) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    if (maxX <= minX || maxY <= minY) return null;
    return [minX, minY, maxX, maxY];
  }
  return null;
}

export function VisualReferencePicker(props: VisualReferencePickerProps) {
  // Internal state holder for activeSourceAssetId when uncontrolled.
  const isControlled = props.onActiveSourceAssetIdChange !== undefined;
  const [internalActive, setInternalActive] = useState<string | null>(
    props.activeSourceAssetId ?? props.assetId ?? null,
  );
  const activeSourceAssetId = isControlled
    ? props.activeSourceAssetId ?? null
    : internalActive;
  const setActive = (id: string | null) => {
    if (isControlled) {
      props.onActiveSourceAssetIdChange?.(id);
    } else {
      setInternalActive(id);
    }
  };

  const classesById = useMemo(() => {
    const m = new Map<string, ClassRow>();
    for (const c of props.classes) m.set(c.id, c);
    return m;
  }, [props.classes]);

  // Fall back to current asset / first pickable when active becomes invalid.
  useEffect(() => {
    if (!props.pickableAssets.length) {
      if (activeSourceAssetId !== null) setActive(null);
      return;
    }
    if (
      !activeSourceAssetId ||
      !props.pickableAssets.some((a) => a.id === activeSourceAssetId)
    ) {
      const fallback =
        props.pickableAssets.find((a) => a.id === props.assetId) ??
        props.pickableAssets[0];
      setActive(fallback?.id ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pickableAssets, props.assetId]);

  // References shown for the active source asset.
  //   * Current asset → prefer the editor's live store (in-flight
  //                     bboxes the user just drew show up immediately).
  //   * Other asset   → use the parent-supplied annotationsByAssetId.
  const visualReferences = useMemo<VisualReference[]>(() => {
    if (!activeSourceAssetId) return [];
    const out: VisualReference[] = [];
    if (activeSourceAssetId === props.assetId) {
      // Live editor store path
      for (const [tempId, a] of Object.entries(props.annotationsById)) {
        if (a.kind !== "bbox" && a.kind !== "polygon") continue;
        const xyxy = geometryToXyxy(a.geometry);
        if (!xyxy) continue;
        const cls = classesById.get(a.classId);
        const geom: VisualReference["geometry"] =
          a.kind === "bbox"
            ? { kind: "bbox", xyxy }
            : {
                kind: "polygon",
                points: (a.geometry as { points: [number, number][] }).points,
              };
        out.push({
          id: a.serverId ?? tempId,
          sourceKind: a.kind as "bbox" | "polygon",
          xyxy,
          geometry: geom,
          className: cls?.name ?? "<unmapped>",
          sourceClassId: a.classId,
          color: cls?.color ?? "#9ca3af",
        });
      }
    } else {
      const refs = props.annotationsByAssetId.get(activeSourceAssetId) ?? [];
      for (const r of refs) {
        const xyxy = geometryToXyxy(r.geometry as never);
        if (!xyxy) continue;
        const cls = classesById.get(r.classId);
        const geom: VisualReference["geometry"] =
          r.kind === "bbox"
            ? { kind: "bbox", xyxy }
            : {
                kind: "polygon",
                points: (r.geometry as unknown as {
                  points: [number, number][];
                }).points,
              };
        out.push({
          id: r.id,
          sourceKind: r.kind,
          xyxy,
          geometry: geom,
          className: cls?.name ?? "<unmapped>",
          sourceClassId: r.classId,
          color: cls?.color ?? "#9ca3af",
        });
      }
    }
    // Sort: bboxes first (more direct visual prompt), then by id stable.
    out.sort((p, q) => {
      if (p.sourceKind !== q.sourceKind) {
        return p.sourceKind === "bbox" ? -1 : 1;
      }
      return p.id.localeCompare(q.id);
    });
    return out;
  }, [
    activeSourceAssetId,
    props.assetId,
    props.annotationsById,
    props.annotationsByAssetId,
    classesById,
  ]);

  const filteredReferences = useMemo(
    () =>
      props.refKindFilter
        ? visualReferences.filter((r) => r.sourceKind === props.refKindFilter)
        : visualReferences,
    [visualReferences, props.refKindFilter],
  );

  function toggleVisual(refId: string) {
    if (!activeSourceAssetId) return;
    const key = pickKey(activeSourceAssetId, refId);
    const next = { ...props.picks };
    if (key in next) {
      delete next[key];
    } else {
      const ref = filteredReferences.find((r) => r.id === refId);
      if (!ref) return;
      next[key] = {
        assetId: activeSourceAssetId,
        annotationId: refId,
        classId: ref.sourceClassId,
        className: ref.className,
        color: ref.color,
        sourceKind: ref.sourceKind,
        geometry: ref.geometry,
      };
    }
    props.onPicksChange(next);
  }

  function setVisualClass(refId: string, classId: string) {
    if (!activeSourceAssetId) return;
    const key = pickKey(activeSourceAssetId, refId);
    if (!(key in props.picks)) return;
    const existing = props.picks[key];
    if (!existing) return;
    const next = { ...props.picks, [key]: { ...existing, classId } };
    props.onPicksChange(next);
  }

  return (
    <div className="grid gap-2">
      {/* Thumbnail strip — switch source asset */}
      {props.loading ? (
        <div
          className="flex items-center gap-2 text-[11px] text-[color:var(--text-tertiary)] px-2 py-1.5"
          data-testid="yoloe-visual-loading"
        >
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading task assets &amp; annotations…
        </div>
      ) : props.pickableAssets.length === 0 ? null : (
        <div
          className="flex gap-1.5 overflow-x-auto pb-1.5 -mx-1 px-1"
          data-testid="yoloe-visual-source-strip"
        >
          {props.pickableAssets.map((a) => {
            const isActive = a.id === activeSourceAssetId;
            const sourcePicks = Object.values(props.picks).filter(
              (p) => p.assetId === a.id,
            );
            const hasPicks = sourcePicks.length > 0;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => setActive(a.id)}
                data-testid={`yoloe-visual-source-${a.id}`}
                title={a.original_name}
                className={cn(
                  "shrink-0 grid gap-1 p-1 rounded-[var(--radius-md)] border",
                  "transition-all duration-[160ms]",
                  isActive
                    ? "border-[color:var(--accent)] shadow-[0_0_0_1px_var(--accent)] scale-[1.03]"
                    : hasPicks
                      ? "border-[color:var(--accent)]/40 hover:border-[color:var(--accent)]"
                      : "border-[var(--border-subtle)] hover:border-[var(--text-tertiary)]",
                )}
              >
                <div className="relative h-12 w-16 rounded-sm overflow-hidden bg-[var(--bg-subtle)]">
                  {a.thumbnail_url ? (
                    <img
                      src={a.thumbnail_url}
                      alt={a.original_name}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="h-full w-full grid place-items-center text-[10px] text-[color:var(--text-tertiary)]">
                      no thumb
                    </div>
                  )}
                  {hasPicks && (
                    <span
                      className="absolute top-0.5 right-0.5 inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-[var(--accent)] text-white text-[9px] font-medium leading-none"
                      aria-label={`${sourcePicks.length} picks`}
                    >
                      {sourcePicks.length}
                    </span>
                  )}
                </div>
                <span className="text-[10px] truncate max-w-[64px] text-center text-[color:var(--text-secondary)]">
                  {a.original_name}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Per-source refs panel */}
      {props.pickableAssets.length === 0 ? (
        <div className="grid gap-2 p-3 rounded-[var(--radius-md)] border border-dashed border-[var(--border-subtle)] bg-[var(--bg-subtle)]">
          <div className="flex items-start gap-2 text-[12px] text-[color:var(--text-secondary)]">
            <Wand2
              className="h-4 w-4 mt-0.5 text-[color:var(--accent)]"
              aria-hidden
            />
            <div>
              <div className="font-medium text-[color:var(--text-primary)]">
                No bbox/polygon annotations in this task.
              </div>
              <div>
                Draw at least one bbox or polygon (or use SAM) on any image
                asset in this task, then re-open this dialog.
              </div>
            </div>
          </div>
        </div>
      ) : filteredReferences.length === 0 ? (
        <div className="grid gap-1 p-3 rounded-[var(--radius-md)] border border-dashed border-[var(--border-subtle)] bg-[var(--bg-subtle)] text-[12px] text-[color:var(--text-secondary)]">
          No bbox/polygon annotations on the selected source. Draw some on
          this asset, or pick another source above.
        </div>
      ) : (
        <div
          className="grid gap-1 max-h-[220px] overflow-y-auto p-1 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)]"
          data-testid="yoloe-visual-refs"
        >
          {filteredReferences.map((r) => {
            const key = activeSourceAssetId
              ? pickKey(activeSourceAssetId, r.id)
              : r.id;
            const pick = props.picks[key];
            const picked = !!pick;
            const assignedCid = pick?.classId ?? "";
            const assignedCls = props.classes.find(
              (c) => c.id === assignedCid,
            );
            const w = Math.round(r.xyxy[2] - r.xyxy[0]);
            const h = Math.round(r.xyxy[3] - r.xyxy[1]);
            return (
              <div
                key={r.id}
                data-testid={`yoloe-visual-ref-${r.id}`}
                className={cn(
                  "grid grid-cols-[20px_minmax(0,1fr)_minmax(0,180px)_auto] gap-2 items-center px-2 py-1.5 rounded-[var(--radius-sm)]",
                  "transition-all duration-[140ms]",
                  picked
                    ? "bg-[var(--accent)]/8 shadow-[0_0_0_1px_var(--accent)]"
                    : "hover:bg-[var(--bg-hover)]",
                )}
              >
                <button
                  type="button"
                  onClick={() => toggleVisual(r.id)}
                  aria-pressed={picked}
                  aria-label={picked ? "Unpick reference" : "Pick reference"}
                  className={cn(
                    "h-4 w-4 rounded-sm border grid place-items-center",
                    "transition-all duration-[140ms]",
                    picked
                      ? "bg-[var(--accent)] border-[var(--accent)]"
                      : "border-[var(--border-subtle)] hover:border-[color:var(--accent)]",
                  )}
                >
                  {picked && (
                    <CheckCircle2
                      className="h-3 w-3 text-white"
                      strokeWidth={3}
                    />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => toggleVisual(r.id)}
                  className="flex items-center gap-1.5 min-w-0 text-left"
                >
                  <span
                    className="h-2.5 w-2.5 rounded-sm shrink-0 ring-1 ring-black/10"
                    style={{ backgroundColor: r.color }}
                    aria-hidden
                  />
                  <span className="text-[12px] truncate">{r.className}</span>
                  <span className="text-[10px] font-mono text-[color:var(--text-tertiary)] tabular-nums">
                    {r.sourceKind} · {w}×{h}
                  </span>
                </button>
                {picked ? (
                  <div className="flex items-center gap-1 min-w-0">
                    <span className="text-[10.5px] text-[color:var(--text-tertiary)] shrink-0">
                      →
                    </span>
                    <select
                      value={assignedCid}
                      onChange={(e) => setVisualClass(r.id, e.target.value)}
                      data-testid={`yoloe-visual-assign-${r.id}`}
                      className={cn(
                        "flex-1 min-w-0 h-7 px-1.5 rounded-[var(--radius-sm)] text-[11.5px]",
                        "bg-transparent outline-none",
                        assignedCid
                          ? "text-[color:var(--text-primary)]"
                          : "text-[color:var(--danger,#d4504a)]",
                        "hover:bg-[var(--bg-hover)]",
                      )}
                    >
                      <option value="">Pick class *</option>
                      {props.classes.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <span className="text-[10.5px] text-[color:var(--text-tertiary)] italic">
                    not picked
                  </span>
                )}
                <span
                  className="h-2.5 w-2.5 rounded-full shrink-0"
                  style={{
                    backgroundColor: assignedCls?.color ?? "transparent",
                    border: assignedCls
                      ? "none"
                      : "1px dashed var(--border-subtle)",
                  }}
                  aria-hidden
                  title={
                    assignedCls
                      ? `Matches saved as ${assignedCls.name}`
                      : "No class assigned yet"
                  }
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
