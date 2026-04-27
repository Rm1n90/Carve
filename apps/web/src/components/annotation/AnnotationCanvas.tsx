import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CanvasApp } from "@/canvas/App";
import { BboxTool, type Point } from "@/canvas/tools/BboxTool";
import { PolygonTool, CLOSE_RADIUS_PX } from "@/canvas/tools/PolygonTool";
import { MaskBrushTool } from "@/canvas/tools/MaskBrushTool";
import { TagTool } from "@/canvas/tools/TagTool";
import { SamTool } from "@/canvas/tools/SamTool";
import { useTool, type ToolName } from "@/state/tool";
import { useAnnotations, type AnnotationDraft } from "@/state/annotations";
import { renderBbox, renderPolygon } from "@/canvas/ShapeRenderer";
import { CrosshairOverlay } from "@/components/annotation/CrosshairOverlay";
import { AnnotationContextMenu } from "@/components/annotation/AnnotationContextMenu";

interface Props {
  /** Intrinsic image width (px). Optional now — kept for compat with existing call sites. */
  width?: number;
  /** Intrinsic image height (px). Optional now — kept for compat with existing call sites. */
  height?: number;
  imageUrl: string;
  frameId: string | null;
  assetId: string;
  /** Optional: callback fired when zoom changes so the page can render it. */
  onZoomChange?: (pct: number) => void;
  /**
   * Map of classId → hex color (`#RRGGBB`). Replaces the previous
   * window-CustomEvent propagation, which had a race on first mount where
   * shapes briefly rendered in the default amber color. See audit bug H.
   */
  classColorMap?: Record<string, string>;
}

const DEFAULT_AMBER = 0xeab308;
const EMPTY_CLASS_MAP: Readonly<Record<string, string>> = Object.freeze({});

function hexFromColor(color: string | undefined): number {
  if (!color) return DEFAULT_AMBER;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(color.trim());
  if (m) return parseInt(m[1], 16);
  return DEFAULT_AMBER;
}

/**
 * Mounts a Pixi canvas, loads the image, scales it to fit the host, routes
 * pointer/keyboard events to the active tool, and renders annotations from
 * the store onto the shape layer. Live drag preview lives on the overlay
 * layer and clears on commit.
 */
export function AnnotationCanvas({
  imageUrl,
  frameId,
  assetId,
  onZoomChange,
  classColorMap,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<CanvasApp | null>(null);
  const tool = useTool((s) => s.active);
  const activeClassId = useTool((s) => s.activeClassId);

  // SamTool retains state (image_hash, accumulated points) across pointer
  // event re-renders. Recreate only when the asset (or active frame) changes.
  const samTool = useMemo(
    () =>
      new SamTool(
        assetId,
        () => useTool.getState().activeClassId,
        () => frameId,
      ),
    [assetId, frameId],
  );

  const [imageSize, setImageSize] = useState<{ w: number; h: number }>({ w: 1, h: 1 });
  const [hostSize, setHostSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const scaleRef = useRef(1);
  const offsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const previewGfxRef = useRef<unknown | null>(null);
  const shapeGfxByIdRef = useRef<Map<string, unknown>>(new Map());
  // Empty map fallback so the renderer doesn't depend on prop being provided.
  const classMap = classColorMap ?? EMPTY_CLASS_MAP;
  // Live ref for the in-flight polygon preview graphics. Mirrors previewGfxRef
  // (used for bbox) but rendered as separate vertex/edge/rubber-band primitives.
  const polygonPreviewGfxRef = useRef<unknown | null>(null);

  // ----- Mount Pixi app once. Re-mount when imageUrl changes.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    const app = new CanvasApp({ width: 1, height: 1, backgroundAlpha: 0 });
    appRef.current = app;

    (async () => {
      await app.init({ width: 1, height: 1, backgroundAlpha: 0 });
      if (cancelled) {
        app.destroy();
        return;
      }
      host.appendChild(app.app.canvas);
      const cv = app.app.canvas as HTMLCanvasElement;
      cv.style.position = "absolute";
      cv.style.inset = "0";
      cv.style.width = "100%";
      cv.style.height = "100%";

      // Load image into imageLayer
      try {
        const { Assets, Sprite } = await import("pixi.js");
        const tex = await Assets.load(imageUrl);
        if (cancelled) return;
        const sprite = new Sprite(tex);
        app.imageLayer.addChild(sprite);
        const realW = sprite.width || 1;
        const realH = sprite.height || 1;
        setImageSize({ w: realW, h: realH });
      } catch {
        // Image load failures (e.g. headless environments) leave canvas empty.
      }
    })();

    return () => {
      cancelled = true;
      try {
        app.destroy();
      } catch {
        /* ignore cleanup errors */
      }
      appRef.current = null;
      shapeGfxByIdRef.current.clear();
      previewGfxRef.current = null;
    };
  }, [imageUrl]);

  // ----- Track host element size (for fit-to-host scaling).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width: w, height: h } = entry.contentRect;
      if (w > 0 && h > 0) setHostSize({ w, h });
    });
    ro.observe(host);
    // Seed size synchronously so the first paint isn't 0×0.
    const r = host.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) setHostSize({ w: r.width, h: r.height });
    return () => ro.disconnect();
  }, []);

  // ----- Resize the Pixi renderer + recompute scale whenever host or image size changes.
  useEffect(() => {
    const app = appRef.current;
    if (!app) return;
    const { w: hw, h: hh } = hostSize;
    const { w: iw, h: ih } = imageSize;
    if (hw <= 0 || hh <= 0 || iw <= 0 || ih <= 0) return;
    try {
      app.app.renderer.resize(hw, hh);
    } catch {
      /* renderer not ready */
    }
    const padding = 16;
    const sx = (hw - padding * 2) / iw;
    const sy = (hh - padding * 2) / ih;
    const s = Math.min(sx, sy, 1);
    scaleRef.current = s;
    const drawnW = iw * s;
    const drawnH = ih * s;
    const ox = (hw - drawnW) / 2;
    const oy = (hh - drawnH) / 2;
    offsetRef.current = { x: ox, y: oy };
    [app.imageLayer, app.shapeLayer, app.overlayLayer].forEach((layer) => {
      layer.position.set(ox, oy);
      layer.scale.set(s, s);
    });
    onZoomChange?.(s * 100);
  }, [hostSize, imageSize, onZoomChange]);

  // Class colors now arrive via the `classColorMap` prop (see audit bug H).
  // The window-event approach had a race on first mount where the canvas
  // listener registered after the dispatch fired, leaving shapes amber.

  // ----- Render annotations from the store onto shapeLayer.
  useEffect(() => {
    let mounted = true;

    async function reconcile(state: {
      byId: Record<string, AnnotationDraft>;
      selectedId: string | null;
      selectedIds: string[];
      hiddenClassIds: string[];
      hiddenAnnotationIds: string[];
    }) {
      const app = appRef.current;
      if (!app || !mounted) return;
      let Graphics: typeof import("pixi.js").Graphics | undefined;
      try {
        const pixi = await import("pixi.js");
        Graphics = pixi.Graphics;
      } catch {
        return;
      }
      if (!Graphics || !mounted) return;
      const gfxMap = shapeGfxByIdRef.current;
      const seen = new Set<string>();
      const hovered = useTool.getState().hoveredAnnotationId;
      const visAnn = useTool.getState().visibility.annotations;
      const sortedDrafts = Object.values(state.byId)
        .filter((d) => d.frameId === frameId)
        .sort((a, b) => (a.zOrder ?? 0) - (b.zOrder ?? 0));
      for (const draft of sortedDrafts) {
        const id = draft.tempId;
        const hidden =
          state.hiddenAnnotationIds.includes(id) ||
          state.hiddenClassIds.includes(draft.classId);
        const g =
          (gfxMap.get(id) as InstanceType<typeof Graphics> | undefined) ?? new Graphics();
        if (!gfxMap.has(id)) {
          gfxMap.set(id, g);
          app.shapeLayer.addChild(g);
        }
        if (!visAnn || hidden) {
          (g as { clear?: () => void }).clear?.();
          (g as { visible?: boolean }).visible = false;
          seen.add(id);
          continue;
        }
        (g as { visible?: boolean }).visible = true;
        const color = hexFromColor(classMap[draft.classId]);
        const isSelected =
          state.selectedId === id || state.selectedIds.includes(id);
        const isHovered = hovered === id;
        if (draft.geometry.kind === "bbox") {
          renderBbox(g, draft.geometry, color, isSelected || isHovered);
        } else if (draft.geometry.kind === "polygon") {
          renderPolygon(g, draft.geometry, color, isSelected || isHovered);
        }
        seen.add(id);
      }
      for (const id of Array.from(gfxMap.keys())) {
        if (!seen.has(id)) {
          const g = gfxMap.get(id) as InstanceType<typeof Graphics> | undefined;
          if (g) {
            try {
              app.shapeLayer.removeChild(g as never);
            } catch {
              /* ignore */
            }
          }
          gfxMap.delete(id);
        }
      }
    }

    void reconcile(useAnnotations.getState());
    const unsubA = useAnnotations.subscribe((state) => {
      void reconcile(state);
    });
    const unsubT = useTool.subscribe(() => {
      void reconcile(useAnnotations.getState());
    });
    return () => {
      mounted = false;
      unsubA();
      unsubT();
    };
  }, [frameId, classMap, imageSize]);

  // ----- Draw / clear the live preview rectangle while dragging a bbox.
  async function drawPreviewRect(rect: { x: number; y: number; w: number; h: number }) {
    const app = appRef.current;
    if (!app) return;
    let Graphics: typeof import("pixi.js").Graphics | undefined;
    try {
      const pixi = await import("pixi.js");
      Graphics = pixi.Graphics;
    } catch {
      return;
    }
    if (!Graphics) return;
    let g = previewGfxRef.current as InstanceType<typeof Graphics> | null;
    if (!g) {
      g = new Graphics();
      previewGfxRef.current = g;
      app.overlayLayer.addChild(g);
    }
    g.clear();
    g.rect(rect.x, rect.y, rect.w, rect.h);
    g.stroke({ color: 0x6366f1, width: 2, alpha: 1 });
    g.fill({ color: 0x6366f1, alpha: 0.12 });
  }

  function clearPreview() {
    const g = previewGfxRef.current as { clear?: () => void } | null;
    if (g && typeof g.clear === "function") g.clear();
  }

  // ----- Polygon in-progress preview (vertices + edges + rubber-band).
  async function drawPolygonPreview(
    vertices: readonly Point[],
    cursor: Point | null,
    closeHint: boolean,
  ) {
    const app = appRef.current;
    if (!app) return;
    let Graphics: typeof import("pixi.js").Graphics | undefined;
    try {
      const pixi = await import("pixi.js");
      Graphics = pixi.Graphics;
    } catch {
      return;
    }
    if (!Graphics) return;
    let g = polygonPreviewGfxRef.current as InstanceType<typeof Graphics> | null;
    if (!g) {
      g = new Graphics();
      polygonPreviewGfxRef.current = g;
      app.overlayLayer.addChild(g);
    }
    g.clear();
    if (vertices.length === 0) return;

    const indigo = 0x6366f1;

    // Edges between placed vertices.
    if (vertices.length >= 2) {
      g.moveTo(vertices[0].x, vertices[0].y);
      for (let i = 1; i < vertices.length; i++) {
        g.lineTo(vertices[i].x, vertices[i].y);
      }
      g.stroke({ color: indigo, width: 1.5, alpha: 1 });
    }

    // Rubber-band segment from last vertex to current cursor.
    if (cursor && vertices.length >= 1) {
      const last = vertices[vertices.length - 1];
      g.moveTo(last.x, last.y);
      g.lineTo(cursor.x, cursor.y);
      g.stroke({ color: indigo, width: 1.5, alpha: 0.5 });
    }

    // Vertex dots — render last so they sit on top of edges. The first vertex
    // gets a larger ring when the cursor is within CLOSE_RADIUS_PX (and >= 3
    // vertices placed) to indicate "click here to close".
    for (let i = 0; i < vertices.length; i++) {
      const v = vertices[i];
      const isFirst = i === 0;
      const radius = isFirst && closeHint ? 12 : 8;
      g.circle(v.x, v.y, radius);
      g.fill({ color: indigo, alpha: 1 });
      if (isFirst && closeHint) {
        g.circle(v.x, v.y, CLOSE_RADIUS_PX);
        g.stroke({ color: indigo, width: 1.5, alpha: 0.5 });
      }
    }
  }

  function clearPolygonPreview() {
    const g = polygonPreviewGfxRef.current as { clear?: () => void } | null;
    if (g && typeof g.clear === "function") g.clear();
  }

  // ----- Tool routing — recreate per render-relevant change.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const idGen = () => `t-${Math.random().toString(36).slice(2, 11)}`;
    const getClass = () => activeClassId;
    const getFrame = () => frameId;
    const getSize = () => imageSize;

    const bbox = new BboxTool(getClass, getFrame, idGen);
    const polygon = new PolygonTool(getClass, getFrame, idGen);
    const mask = new MaskBrushTool(getClass, getFrame, getSize, 12, idGen);
    const tag = new TagTool(getClass, getFrame, idGen);

    if (tool === "sam") {
      void samTool.activate();
    } else {
      samTool.reset();
    }

    function pointerXY(e: PointerEvent): Point {
      const rect = host!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const s = scaleRef.current || 1;
      const off = offsetRef.current;
      return { x: (cx - off.x) / s, y: (cy - off.y) / s };
    }

    function hitTest(p: Point): string | null {
      const drafts = Object.values(useAnnotations.getState().byId).filter(
        (d) => d.frameId === frameId,
      );
      const hidden = useAnnotations.getState().hiddenAnnotationIds;
      const hClass = useAnnotations.getState().hiddenClassIds;
      // Top-most (highest zOrder) wins.
      const sorted = drafts
        .filter((d) => !hidden.includes(d.tempId) && !hClass.includes(d.classId))
        .sort((a, b) => (b.zOrder ?? 0) - (a.zOrder ?? 0));
      for (const d of sorted) {
        if (d.geometry.kind === "bbox") {
          const { x, y, w, h } = d.geometry;
          if (p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h) {
            return d.tempId;
          }
        } else if (d.geometry.kind === "polygon") {
          const pts = d.geometry.points;
          // Ray-casting test.
          let inside = false;
          for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const xi = pts[i][0], yi = pts[i][1];
            const xj = pts[j][0], yj = pts[j][1];
            const intersect =
              yi > p.y !== yj > p.y &&
              p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + Number.EPSILON) + xi;
            if (intersect) inside = !inside;
          }
          if (inside) return d.tempId;
        }
      }
      return null;
    }

    function onDown(e: PointerEvent) {
      const p = pointerXY(e);
      if (tool === "cursor") {
        const hit = hitTest(p);
        if (hit) {
          if (e.shiftKey) {
            useAnnotations.getState().toggleSelect(hit);
          } else {
            useAnnotations.getState().select(hit);
          }
        } else if (!e.shiftKey) {
          useAnnotations.getState().clearSelection();
        }
        return;
      }
      if (tool === "bbox") bbox.onPointerDown(p);
      else if (tool === "polygon") {
        const r = polygon.onPointerDown(p);
        if (r.committed) {
          clearPolygonPreview();
        } else {
          // Re-render the preview immediately so a newly placed vertex shows
          // even before the next pointer-move arrives.
          const move = polygon.onPointerMove(p);
          if (move) {
            void drawPolygonPreview(move.vertices, move.cursor, move.closeHint);
          }
        }
      }
      else if (tool === "mask") mask.onPointerDown(p);
      else if (tool === "sam") {
        e.preventDefault();
        void samTool.addClick(p, { pointer: e.button });
      }
    }

    function onMove(e: PointerEvent) {
      const p = pointerXY(e);
      if (tool === "bbox") {
        const r = bbox.onPointerMove(p);
        if (r) void drawPreviewRect(r.preview);
      } else if (tool === "polygon") {
        const r = polygon.onPointerMove(p);
        if (r) {
          void drawPolygonPreview(r.vertices, r.cursor, r.closeHint);
        }
      } else if (tool === "mask") {
        mask.onPointerMove(p);
      } else if (tool === "cursor") {
        const hit = hitTest(p);
        const cur = useTool.getState().hoveredAnnotationId;
        if (hit !== cur) useTool.getState().setHoveredAnnotationId(hit);
      }
    }

    function onUp(e: PointerEvent) {
      const p = pointerXY(e);
      if (tool === "bbox") {
        bbox.onPointerUp(p);
        clearPreview();
      } else if (tool === "mask") {
        mask.onPointerUp(p);
      }
    }

    function onContextMenu(e: MouseEvent) {
      if (tool === "sam") e.preventDefault();
    }

    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (tool === "polygon") {
        const r = polygon.onKeyDown(e.key);
        if (r.committed || r.cancelled) clearPolygonPreview();
      }
      else if (tool === "mask") mask.onKeyDown(e.key);
      else if (tool === "tag" && e.key.toLowerCase() === "t") tag.apply();
      else if (tool === "sam") {
        if (e.key === "Enter") samTool.commit();
        else if (e.key === "Escape") samTool.reset();
      }
    }

    host.addEventListener("pointerdown", onDown);
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerup", onUp);
    host.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("keydown", onKey);
    return () => {
      host.removeEventListener("pointerdown", onDown);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerup", onUp);
      host.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("keydown", onKey);
      // Reset any in-flight polygon when the tool changes / the asset
      // unmounts so the preview doesn't linger.
      polygon.cancel();
      clearPolygonPreview();
    };
  }, [tool, activeClassId, frameId, imageSize, samTool]);

  const crosshairsOn = useTool((s) => s.visibility.crosshairs);
  const showCrosshair =
    crosshairsOn && (tool === "bbox" || tool === "polygon" || tool === "mask" || tool === "sam");

  const toImageXY = useCallback(
    (clientX: number, clientY: number) => {
      const host = hostRef.current;
      if (!host) return { x: 0, y: 0 };
      const rect = host.getBoundingClientRect();
      const cx = clientX - rect.left;
      const cy = clientY - rect.top;
      const s = scaleRef.current || 1;
      const off = offsetRef.current;
      return { x: (cx - off.x) / s, y: (cy - off.y) / s };
    },
    [],
  );

  const hitTestClient = useCallback(
    (clientX: number, clientY: number): string | null => {
      const p = toImageXY(clientX, clientY);
      const drafts = Object.values(useAnnotations.getState().byId).filter(
        (d) => d.frameId === frameId,
      );
      const hidden = useAnnotations.getState().hiddenAnnotationIds;
      const hClass = useAnnotations.getState().hiddenClassIds;
      const sorted = drafts
        .filter((d) => !hidden.includes(d.tempId) && !hClass.includes(d.classId))
        .sort((a, b) => (b.zOrder ?? 0) - (a.zOrder ?? 0));
      for (const d of sorted) {
        if (d.geometry.kind === "bbox") {
          const { x, y, w, h } = d.geometry;
          if (p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h) {
            return d.tempId;
          }
        } else if (d.geometry.kind === "polygon") {
          const pts = d.geometry.points;
          let inside = false;
          for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const xi = pts[i][0], yi = pts[i][1];
            const xj = pts[j][0], yj = pts[j][1];
            const intersect =
              yi > p.y !== yj > p.y &&
              p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + Number.EPSILON) + xi;
            if (intersect) inside = !inside;
          }
          if (inside) return d.tempId;
        }
      }
      return null;
    },
    [toImageXY, frameId],
  );

  return (
    <div
      ref={hostRef}
      role="region"
      aria-label={`Annotation canvas (${tool})`}
      className="canvas-checker"
      style={{
        position: "absolute",
        inset: 0,
        cursor: toolCursor(tool),
        overflow: "hidden",
        touchAction: "none",
      }}
    >
      <CrosshairOverlay
        hostRef={hostRef}
        toImageXY={toImageXY}
        enabled={showCrosshair}
      />
      <AnnotationContextMenu hostRef={hostRef} hitTest={hitTestClient} />
    </div>
  );
}

function toolCursor(t: ToolName): string {
  switch (t) {
    case "bbox":
    case "polygon":
    case "mask":
    case "sam":
      return "crosshair";
    default:
      return "default";
  }
}
