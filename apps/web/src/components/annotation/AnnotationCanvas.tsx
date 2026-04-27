import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CanvasApp } from "@/canvas/App";
import { BboxTool, type Point } from "@/canvas/tools/BboxTool";
import { PolygonTool, CLOSE_RADIUS_PX } from "@/canvas/tools/PolygonTool";
import { MaskBrushTool } from "@/canvas/tools/MaskBrushTool";
import { TagTool } from "@/canvas/tools/TagTool";
import { SamTool } from "@/canvas/tools/SamTool";
import { useTool, type ToolName } from "@/state/tool";
import { useAnnotations, type AnnotationDraft, type Bbox, type Polygon } from "@/state/annotations";
import {
  renderBbox,
  renderPolygon,
  cursorForHandle,
  type BboxHandleName,
} from "@/canvas/ShapeRenderer";
import {
  applyResize,
  applyTranslate,
  hitTestHandle,
  pointInsideBbox,
} from "@/canvas/bboxEdit";
import {
  applyVertexTranslate,
  hitTestVertex,
} from "@/canvas/polygonEdit";
import { showToast } from "@/lib/toast";
import { CrosshairOverlay } from "@/components/annotation/CrosshairOverlay";
import { AnnotationContextMenu } from "@/components/annotation/AnnotationContextMenu";

/**
 * State of the underlying image's load lifecycle. Surfaced to callers
 * (the editor page) so they can render a status badge and an error overlay
 * when loading fails. Phase A core 1.
 */
export type ImageLoadStatus = "loading" | "loaded" | "error";

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
   * Optional: callback fired when the image load lifecycle changes. The
   * callback receives a status string and, on error, an error message.
   * Phase A core 1 — without this, image load failures left a blank canvas
   * with no feedback. See ref code path in `useEffect` below.
   */
  onImageStatusChange?: (status: ImageLoadStatus, errorMessage?: string) => void;
  /** Bumps when the parent wants the canvas to retry loading the image. */
  reloadKey?: number;
  /**
   * Map of classId → hex color (`#RRGGBB`). Replaces the previous
   * window-CustomEvent propagation, which had a race on first mount where
   * shapes briefly rendered in the default amber color. See audit bug H.
   */
  classColorMap?: Record<string, string>;
  /**
   * Map of classId → display name. Used to render small floating tags
   * above each bbox when the `labels` visibility flag is on. See audit
   * bug O. Falls back to "?" if a class is missing from the map.
   */
  classNameMap?: Record<string, string>;
}

const DEFAULT_AMBER = 0xeab308;
const EMPTY_CLASS_MAP: Readonly<Record<string, string>> = Object.freeze({});

/**
 * Convert a hex color string (e.g. "#ff0000" or "ff0000") into the numeric
 * form Pixi expects. On any non-conforming input — including the OKLCH
 * `var(--swatch-N)` strings the design tokens emit — fall back to amber.
 *
 * Defensive: wrapped in try/catch so a malformed input never crashes the
 * render pipeline. See audit bug Q.
 */
export function hexFromColor(color: string | undefined): number {
  try {
    if (!color || typeof color !== "string") return DEFAULT_AMBER;
    const trimmed = color.trim();
    const m = /^#?([0-9a-fA-F]{6})$/.exec(trimmed);
    if (m) {
      const n = parseInt(m[1], 16);
      // Guard against NaN from a malformed digit class — paranoia.
      return Number.isFinite(n) ? n : DEFAULT_AMBER;
    }
    return DEFAULT_AMBER;
  } catch {
    return DEFAULT_AMBER;
  }
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
  onImageStatusChange,
  reloadKey,
  classColorMap,
  classNameMap,
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
  // Active bbox-edit drag state. Lives in a ref so updates don't re-trigger
  // the tool-routing useEffect (which would recreate every pointer handler).
  const dragRef = useRef<
    | { mode: "translate"; id: string; offset: Point; original: Bbox }
    | { mode: "resize"; id: string; handle: BboxHandleName; original: Bbox }
    | { mode: "vertex"; id: string; index: number; original: Polygon }
    | null
  >(null);
  // Cursor override during a drag — clears when the drag ends.
  const [dragCursor, setDragCursor] = useState<string | null>(null);
  // Empty map fallback so the renderer doesn't depend on prop being provided.
  const classMap = classColorMap ?? EMPTY_CLASS_MAP;
  const classNames = classNameMap ?? EMPTY_CLASS_MAP;
  // Live ref for the in-flight polygon preview graphics. Mirrors previewGfxRef
  // (used for bbox) but rendered as separate vertex/edge/rubber-band primitives.
  const polygonPreviewGfxRef = useRef<unknown | null>(null);
  // Per-annotation label tag (a Pixi Container holding a fill rect + Text).
  // Rendered above each bbox when the `labels` visibility flag is on.
  // Audit bug O.
  const labelGfxByIdRef = useRef<Map<string, { container: unknown; text: unknown; bg: unknown }>>(
    new Map(),
  );

  // ----- Mount Pixi app once. Re-mount when imageUrl changes (or reloadKey
  // bumps, signalling a parent-driven retry after an image-load error).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    onImageStatusChange?.("loading");
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

      // Pre-flight the image with a plain HTMLImageElement. Pixi's Assets cache
      // sometimes hides 404s as an empty texture; the <img> error handler is
      // the simplest reliable signal we can surface to the parent. Phase A
      // core 1.
      try {
        await new Promise<void>((resolve, reject) => {
          const probe = new Image();
          probe.onload = () => resolve();
          probe.onerror = () =>
            reject(new Error("network or 404 — image could not be fetched"));
          // Allow cross-origin texture sampling in Pixi later.
          probe.crossOrigin = "anonymous";
          probe.src = imageUrl;
        });
      } catch (e) {
        if (cancelled) return;
        const message =
          e instanceof Error ? e.message : "image failed to load";
        onImageStatusChange?.("error", message);
        return;
      }

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
        onImageStatusChange?.("loaded");
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : "pixi load failed";
        onImageStatusChange?.("error", message);
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
      labelGfxByIdRef.current.clear();
      previewGfxRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl, reloadKey]);

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
      const labelMap = labelGfxByIdRef.current;
      const seen = new Set<string>();
      const seenLabels = new Set<string>();
      const hovered = useTool.getState().hoveredAnnotationId;
      const vis = useTool.getState().visibility;
      const visAnn = vis.annotations;
      const visLabels = vis.labels;
      const visPixels = vis.pixels;
      const activeTool = useTool.getState().active;
      // Handles only render when the cursor (transform) tool is active —
      // they'd visually compete with the bbox-tool's drag preview otherwise.
      const showHandles = activeTool === "cursor";
      // Lazy-import Container / Text only when we actually need a label.
      // We keep them in this scope so each label render uses one resolved
      // module reference (cheaper than re-importing per draft).
      let pixiText:
        | typeof import("pixi.js").Text
        | undefined;
      let pixiContainer:
        | typeof import("pixi.js").Container
        | undefined;
      const sortedDrafts = Object.values(state.byId)
        .filter((d) => d.frameId === frameId)
        .sort((a, b) => (a.zOrder ?? 0) - (b.zOrder ?? 0));
      for (const draft of sortedDrafts) {
        const id = draft.tempId;
        const hidden =
          state.hiddenAnnotationIds.includes(id) ||
          state.hiddenClassIds.includes(draft.classId);
        // Pixels visibility — currently only gates mask annotations (the
        // mask renderer is a placeholder; future raster decoding will hook
        // here). When pixels=false, hide masks entirely. Audit bug O.
        const isMask = draft.kind === "mask";
        const hiddenByPixels = isMask && !visPixels;
        const g =
          (gfxMap.get(id) as InstanceType<typeof Graphics> | undefined) ?? new Graphics();
        if (!gfxMap.has(id)) {
          gfxMap.set(id, g);
          app.shapeLayer.addChild(g);
        }
        if (!visAnn || hidden || hiddenByPixels) {
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
          renderBbox(
            g,
            draft.geometry,
            color,
            isSelected || isHovered,
            showHandles && isSelected,
          );
          // Class-name tag floating above the bbox top-left when the
          // `labels` flag is on. Skipped when the label flag is off OR no
          // name is known for the class (defensive).
          if (visLabels) {
            const className = classNames[draft.classId];
            if (className) {
              if (!pixiText || !pixiContainer) {
                try {
                  const pixi = await import("pixi.js");
                  pixiText = pixi.Text;
                  pixiContainer = pixi.Container;
                } catch {
                  /* leave undefined; loop below skips */
                }
              }
              if (pixiText && pixiContainer) {
                renderLabel(
                  app.shapeLayer as unknown as { addChild: (c: never) => unknown },
                  labelMap,
                  id,
                  draft.geometry,
                  className,
                  color,
                  pixiText,
                  pixiContainer,
                  Graphics,
                );
                seenLabels.add(id);
              }
            }
          }
        } else if (draft.geometry.kind === "polygon") {
          renderPolygon(
            g,
            draft.geometry,
            color,
            isSelected || isHovered,
            showHandles && isSelected,
          );
        }
        seen.add(id);
      }
      // Remove labels for drafts that aren't visible / weren't seen.
      for (const id of Array.from(labelMap.keys())) {
        if (!seenLabels.has(id)) {
          const entry = labelMap.get(id);
          if (entry) {
            try {
              app.shapeLayer.removeChild(entry.container as never);
            } catch {
              /* ignore */
            }
          }
          labelMap.delete(id);
        }
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
  }, [frameId, classMap, classNames, imageSize]);

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
      // SAM activation calls /sam/encode. When the model service is offline
      // (audit bug 8a), the api now returns 503 model_service_unreachable.
      // Surface that to the user as a toast — without it the failed promise
      // would just become an unhandled rejection in the console.
      void samTool.activate().catch((err: unknown) => {
        const message = describeSamError(err);
        showToast(message, { variant: "error", duration: 5000 });
      });
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

    function getSelectedBbox(): { id: string; bbox: Bbox } | null {
      const state = useAnnotations.getState();
      for (const id of state.selectedIds) {
        const d = state.byId[id];
        if (d && d.geometry.kind === "bbox" && d.frameId === frameId) {
          return { id, bbox: d.geometry };
        }
      }
      return null;
    }

    /** Mirror of ``getSelectedBbox`` for polygon selection. Phase A core 3. */
    function getSelectedPolygon(): { id: string; poly: Polygon } | null {
      const state = useAnnotations.getState();
      for (const id of state.selectedIds) {
        const d = state.byId[id];
        if (d && d.geometry.kind === "polygon" && d.frameId === frameId) {
          return { id, poly: d.geometry };
        }
      }
      return null;
    }

    function onDown(e: PointerEvent) {
      const p = pointerXY(e);
      if (tool === "cursor") {
        // 1. If we have a selected bbox, did we click one of its handles?
        const sel = getSelectedBbox();
        if (sel) {
          const handle = hitTestHandle(sel.bbox, p);
          if (handle) {
            dragRef.current = {
              mode: "resize",
              id: sel.id,
              handle,
              original: sel.bbox,
            };
            setDragCursor(cursorForHandle(handle));
            try {
              host!.setPointerCapture(e.pointerId);
            } catch {
              /* setPointerCapture not always available in jsdom */
            }
            return;
          }
          if (pointInsideBbox(sel.bbox, p)) {
            dragRef.current = {
              mode: "translate",
              id: sel.id,
              offset: { x: p.x - sel.bbox.x, y: p.y - sel.bbox.y },
              original: sel.bbox,
            };
            setDragCursor("move");
            try {
              host!.setPointerCapture(e.pointerId);
            } catch {
              /* ignore */
            }
            return;
          }
        }

        // 1b. If we have a selected polygon, did we click one of its vertex handles?
        const polySel = getSelectedPolygon();
        if (polySel) {
          const idx = hitTestVertex(polySel.poly, p);
          if (idx !== null) {
            dragRef.current = {
              mode: "vertex",
              id: polySel.id,
              index: idx,
              original: polySel.poly,
            };
            setDragCursor("grabbing");
            try {
              host!.setPointerCapture(e.pointerId);
            } catch {
              /* ignore */
            }
            return;
          }
        }

        // 2. No drag intent → fall through to selection (existing behaviour).
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
        const drag = dragRef.current;
        if (drag) {
          // Active drag — translate or resize the selected bbox, or move
          // a polygon vertex (Phase A core 3).
          if (drag.mode === "translate") {
            const next = applyTranslate(
              drag.original,
              p.x - drag.offset.x,
              p.y - drag.offset.y,
            );
            useAnnotations.getState().update(drag.id, { geometry: next });
          } else if (drag.mode === "resize") {
            const next = applyResize(drag.original, drag.handle, p);
            useAnnotations.getState().update(drag.id, { geometry: next });
          } else {
            // mode === "vertex"
            const next = applyVertexTranslate(drag.original, drag.index, p);
            useAnnotations.getState().update(drag.id, { geometry: next });
          }
          return;
        }
        // No drag → update hover + cursor based on what's under the pointer.
        const sel = getSelectedBbox();
        if (sel) {
          const handle = hitTestHandle(sel.bbox, p);
          if (handle) {
            setDragCursor(cursorForHandle(handle));
            useTool.getState().setHoveredAnnotationId(null);
            return;
          }
          if (pointInsideBbox(sel.bbox, p)) {
            setDragCursor("move");
            useTool.getState().setHoveredAnnotationId(null);
            return;
          }
        }
        const polySel = getSelectedPolygon();
        if (polySel) {
          const idx = hitTestVertex(polySel.poly, p);
          if (idx !== null) {
            setDragCursor("grab");
            useTool.getState().setHoveredAnnotationId(null);
            return;
          }
        }
        if (dragCursor !== null) setDragCursor(null);
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
      } else if (tool === "cursor") {
        if (dragRef.current) {
          dragRef.current = null;
          setDragCursor(null);
          try {
            host!.releasePointerCapture(e.pointerId);
          } catch {
            /* not all environments implement releasePointerCapture */
          }
        }
      }
    }

    function onContextMenu(e: MouseEvent) {
      if (tool === "sam") e.preventDefault();
    }

    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (tool === "cursor") {
        // ArrowKey nudge — only when the cursor tool has a bbox selected
        // AND the user has no modifier (asset prev/next is non-modifier
        // ArrowLeft/Right; we want to override only when there's a target).
        const isArrow =
          e.key === "ArrowLeft" ||
          e.key === "ArrowRight" ||
          e.key === "ArrowUp" ||
          e.key === "ArrowDown";
        if (isArrow && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const sel = getSelectedBbox();
          if (sel) {
            e.preventDefault();
            // stopPropagation prevents the asset-nav handler in AnnotateAssetPage
            // from also handling the same key.
            e.stopPropagation();
            const step = e.shiftKey ? 10 : 1;
            const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
            const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
            const next = applyTranslate(sel.bbox, sel.bbox.x + dx, sel.bbox.y + dy);
            useAnnotations.getState().update(sel.id, { geometry: next });
            return;
          }
        }
      }
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
    // Capture-phase keydown so the bbox nudge runs BEFORE the page-level
    // ArrowLeft/Right asset-navigation handler — the canvas calls
    // stopPropagation() when it nudges, preventing accidental nav.
    window.addEventListener("keydown", onKey, true);
    return () => {
      host.removeEventListener("pointerdown", onDown);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerup", onUp);
      host.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("keydown", onKey, true);
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

  /**
   * Vertex-level hit test for the context menu. Walks the currently selected
   * polygon (only — non-selected polygons don't render handles, so right-click
   * on those is treated as a body click). Phase A core 3.
   */
  const vertexHitTestClient = useCallback(
    (clientX: number, clientY: number): { annId: string; vertexIndex: number } | null => {
      const p = toImageXY(clientX, clientY);
      const state = useAnnotations.getState();
      for (const id of state.selectedIds) {
        const d = state.byId[id];
        if (d && d.geometry.kind === "polygon" && d.frameId === frameId) {
          const idx = hitTestVertex(d.geometry, p);
          if (idx !== null) {
            return { annId: id, vertexIndex: idx };
          }
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
        cursor: dragCursor ?? toolCursor(tool),
        overflow: "hidden",
        touchAction: "none",
      }}
    >
      <CrosshairOverlay
        hostRef={hostRef}
        toImageXY={toImageXY}
        enabled={showCrosshair}
      />
      <AnnotationContextMenu
        hostRef={hostRef}
        hitTest={hitTestClient}
        vertexHitTest={vertexHitTestClient}
      />
    </div>
  );
}

/**
 * Render (or update) a small floating tag above the bbox top-left corner
 * showing the class name. The tag is built from a Pixi Container holding
 * a fill rect + Text. The container is added to the shape layer so it
 * inherits the layer's pan/zoom transform without extra math.
 *
 * Pixi text rendering creates a transient texture per .text setter call,
 * so we cache the per-annotation Container in `labelMap` and only update
 * the underlying text/position. Audit bug O.
 */
// Pixi's typings for ``addChild`` are quite strict (variadic typed). We
// only need a minimal contract to attach a child container, so we widen
// at the call sites with these structural types.
interface AddChildSink {
  addChild: (c: never) => unknown;
}

function renderLabel(
  layer: AddChildSink,
  labelMap: Map<string, { container: unknown; text: unknown; bg: unknown }>,
  id: string,
  bbox: { x: number; y: number; w: number; h: number },
  className: string,
  color: number,
  TextCtor: typeof import("pixi.js").Text,
  ContainerCtor: typeof import("pixi.js").Container,
  GraphicsCtor: typeof import("pixi.js").Graphics,
): void {
  let entry = labelMap.get(id);
  if (!entry) {
    const container = new ContainerCtor();
    const bg = new GraphicsCtor();
    const text = new TextCtor({
      text: className,
      style: {
        fontFamily: "Inter, system-ui, sans-serif",
        fontSize: 11,
        fill: 0xffffff,
        fontWeight: "500",
      },
    });
    (container as unknown as AddChildSink).addChild(bg as never);
    (container as unknown as AddChildSink).addChild(text as never);
    layer.addChild(container as never);
    entry = { container, bg, text };
    labelMap.set(id, entry);
  }
  // Update text content if changed.
  const text = entry.text as { text: string; width: number; height: number };
  if (text.text !== className) text.text = className;
  // Lay out: tag height ~14px, padding ~3px h / 2px v.
  const padX = 4;
  const padY = 2;
  const tw = text.width + padX * 2;
  const th = text.height + padY * 2;
  // Position the container above the bbox so the tag's bottom-left aligns
  // with the bbox top-left corner. Small 2px gap.
  const container = entry.container as { position: { set: (x: number, y: number) => void } };
  container.position.set(bbox.x, bbox.y - th - 2);
  // Re-paint the bg rect with the class color.
  const bg = entry.bg as {
    clear: () => void;
    rect: (x: number, y: number, w: number, h: number) => void;
    fill: (opts: { color: number; alpha: number }) => void;
  };
  bg.clear();
  bg.rect(0, 0, tw, th);
  bg.fill({ color, alpha: 1 });
  // Position text inside the bg.
  const tpos = (entry.text as { position: { set: (x: number, y: number) => void } }).position;
  tpos.set(padX, padY);
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

/**
 * Translate a SAM activation/decode failure into a user-friendly toast
 * message. The api returns 503 + ``error: model_service_unreachable``
 * when the model service isn't running; everything else is treated as a
 * generic SAM failure.
 */
function describeSamError(err: unknown): string {
  // Axios error shape: ``err.response.data.error``.
  const errObj = err as { response?: { status?: number; data?: { error?: string } } };
  const status = errObj?.response?.status;
  const errorCode = errObj?.response?.data?.error;
  if (status === 503 || errorCode === "model_service_unreachable") {
    return "SAM unavailable — model service is not running.";
  }
  return "SAM unavailable — please try again later.";
}
