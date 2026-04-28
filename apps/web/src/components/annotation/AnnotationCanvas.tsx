import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CanvasApp } from "@/canvas/App";
import { BboxTool, type Point } from "@/canvas/tools/BboxTool";
import { PolygonTool, CLOSE_RADIUS_PX } from "@/canvas/tools/PolygonTool";
import { MaskBrushTool } from "@/canvas/tools/MaskBrushTool";
import { TagTool } from "@/canvas/tools/TagTool";
import { SamTool } from "@/canvas/tools/SamTool";
import { useTool, type ToolName } from "@/state/tool";
import { useEditorSettings } from "@/state/editorSettings";
import { useAnnotations, type AnnotationDraft, type Bbox, type Polygon } from "@/state/annotations";
import { useFilter } from "@/state/annotationFilter";
import { evaluateFilter, hasMeaningfulRules } from "@/lib/annotation-filter";
import type { ClassRow } from "@/api/classes";
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
import {
  centeredOffset,
  clampScale,
  fitToHost,
  wheelDeltaToFactor,
  zoomAt,
  zoomCentered,
  type ZoomFrame,
  ZOOM_STEP,
} from "@/canvas/zoom";

/** Smooth-ease duration for wheel zoom in ms. ~60ms ease-out feels
 * responsive without snapping. */
const WHEEL_EASE_MS = 60;

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
  /**
   * Project classes — when provided, the right-click context menu shows
   * a "Change class" submenu listing each class with a color chip.
   * Selecting a class calls ``useAnnotations.update``. Defaults to
   * ``undefined`` (entry hidden so legacy tests / hosts unaffected).
   */
  classes?: ClassRow[];
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
 * Deterministic 0xRRGGBB from a string (used by Settings.colorBy = "instance"
 * mode so each annotation gets a stable, distinct color even when its class
 * is shared with siblings). Exported so callers (and tests) can rely on the
 * exact same hashing logic the renderer uses.
 */
export function colorFromString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  // Quantize to a hue bucket and pick a vivid color via a small palette.
  const palette = [
    0x6366f1, 0x14b8a6, 0xf97316, 0xec4899, 0x22c55e, 0xa855f7,
    0xeab308, 0x3b82f6, 0xef4444, 0x06b6d4, 0x84cc16, 0xd946ef,
  ];
  return palette[h % palette.length];
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
  classes: classesProp,
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
  // When `true`, the next host-resize / image-load pass will re-fit the
  // image. Flipped to `false` the moment the user takes any explicit
  // zoom action (wheel, +/−, 1:1, exact %). Resetting to `true` happens
  // when the user clicks the Fit button or presses 0/F. v2.6 zoom.
  const autoFitRef = useRef(true);
  // Wheel-zoom smoothing: we keep the `target` (the eventually-applied
  // frame) and `start` (the frame at the beginning of the current ease)
  // in refs and tween between them inside a requestAnimationFrame loop.
  // A single rAF id is kept so back-to-back wheel events cancel and
  // restart the ease toward the new target rather than stacking.
  const easeRafRef = useRef<number | null>(null);
  const easeStartRef = useRef<{ frame: ZoomFrame; t0: number } | null>(null);
  const easeTargetRef = useRef<ZoomFrame | null>(null);
  const previewGfxRef = useRef<unknown | null>(null);
  // Persistent sprite for the loaded asset image — kept across imageUrl
  // changes so the Pixi Application doesn't have to be torn down on
  // navigation. v2.5 perf fix.
  const imageSpriteRef = useRef<unknown | null>(null);
  // Tracks whether the Pixi app has finished initialising. The
  // texture-swap effect waits on this so a fast first-paint imageUrl
  // change still lands on a ready renderer.
  const [pixiReady, setPixiReady] = useState(false);
  const shapeGfxByIdRef = useRef<Map<string, unknown>>(new Map());
  // Per-annotation mask sprites (for `geometry.kind === "mask_rle"`).
  // Stored separately from `shapeGfxByIdRef` so the bbox/polygon path
  // can `clear()` its Graphics without affecting masks. Each entry holds
  // the Pixi Sprite plus the source canvas/texture so we can dispose
  // cleanly when the draft goes away.
  const maskSpriteByIdRef = useRef<
    Map<string, { sprite: unknown; canvas: HTMLCanvasElement; texture: unknown }>
  >(new Map());
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
  // Live ref for the in-flight mask brush preview sprite. The sprite's
  // texture is built from the MaskRasterizer's OffscreenCanvas; on each
  // pointer-move we tell pixi to refresh the texture.
  const maskPreviewSpriteRef = useRef<unknown | null>(null);
  const maskPreviewTextureRef = useRef<unknown | null>(null);
  // Per-annotation label tag (a Pixi Container holding a fill rect + Text).
  // Rendered above each bbox when the `labels` visibility flag is on.
  // Audit bug O.
  const labelGfxByIdRef = useRef<Map<string, { container: unknown; text: unknown; bg: unknown }>>(
    new Map(),
  );

  // ----- Mount Pixi app ONCE on the host element. Lifecycle is decoupled
  // from imageUrl: navigating between assets only swaps the sprite texture
  // (see the next effect), avoiding the 200-400ms cost of recreating the
  // WebGL context + canvas. v2.5 perf fix.
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
      setPixiReady(true);
    })();

    return () => {
      cancelled = true;
      try {
        app.destroy();
      } catch {
        /* ignore cleanup errors */
      }
      appRef.current = null;
      imageSpriteRef.current = null;
      shapeGfxByIdRef.current.clear();
      labelGfxByIdRef.current.clear();
      previewGfxRef.current = null;
      setPixiReady(false);
    };
  }, []);

  // ----- Swap the image sprite's texture whenever imageUrl changes (or the
  // parent bumps reloadKey to retry after an error). The Pixi app, host
  // canvas, layers, and pointer wiring all stay alive — only the texture
  // is replaced. v2.5 perf fix.
  useEffect(() => {
    if (!pixiReady || !imageUrl) return;
    const app = appRef.current;
    if (!app) return;
    let cancelled = false;
    onImageStatusChange?.("loading");

    (async () => {
      try {
        const { Assets, Sprite } = await import("pixi.js");
        const tex = await Assets.load(imageUrl);
        if (cancelled) {
          // Best-effort: drop the cached texture from Pixi's Assets cache
          // so a stale entry doesn't pin GPU memory after a fast nav.
          try {
            const unload = (Assets as unknown as { unload?: (u: string) => Promise<void> }).unload;
            unload?.(imageUrl).catch(() => undefined);
          } catch {
            /* ignore */
          }
          return;
        }

        // Apply the user's "Smooth image" preference at the time the
        // texture is loaded. Live toggles are handled by the
        // smoothImage subscriber below.
        try {
          const smooth = useEditorSettings.getState().smoothImage;
          const mode = smooth ? "linear" : "nearest";
          const source = (tex as { source?: { scaleMode?: string } }).source;
          if (source) source.scaleMode = mode;
          const baseTex = (tex as { baseTexture?: { scaleMode?: string } }).baseTexture;
          if (baseTex) baseTex.scaleMode = mode;
        } catch {
          /* best-effort */
        }

        const existingSprite = imageSpriteRef.current as
          | { texture: unknown; width: number; height: number }
          | null;

        if (existingSprite) {
          // Reuse the persistent sprite — only the texture handle changes.
          existingSprite.texture = tex;
        } else {
          const sprite = new Sprite(tex);
          app.imageLayer.addChild(sprite);
          imageSpriteRef.current = sprite;
        }

        // Read intrinsic dims off the texture rather than the sprite —
        // Pixi v8's Sprite.width/height reflect the texture only after a
        // re-render, but the texture exposes them synchronously.
        const sourceDims = (tex as {
          width?: number;
          height?: number;
          source?: { width?: number; height?: number };
        });
        const realW =
          sourceDims.width ??
          sourceDims.source?.width ??
          (imageSpriteRef.current as { width?: number } | null)?.width ??
          1;
        const realH =
          sourceDims.height ??
          sourceDims.source?.height ??
          (imageSpriteRef.current as { height?: number } | null)?.height ??
          1;
        setImageSize({ w: realW || 1, h: realH || 1 });
        onImageStatusChange?.("loaded");
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : "image failed to load";
        onImageStatusChange?.("error", message);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl, reloadKey, pixiReady]);

  // ----- Reset shape / label graphics when the asset changes so leftover
  // shapes from the previous asset don't briefly render before the new
  // asset's annotations are seeded into the store. The reconcile effect
  // below repopulates the layer from the store on the next tick.
  useEffect(() => {
    const app = appRef.current;
    const gfxMap = shapeGfxByIdRef.current;
    const labelMap = labelGfxByIdRef.current;
    if (app) {
      for (const g of gfxMap.values()) {
        try {
          app.shapeLayer.removeChild(g as never);
        } catch {
          /* ignore */
        }
      }
      for (const entry of labelMap.values()) {
        try {
          app.shapeLayer.removeChild(entry.container as never);
        } catch {
          /* ignore */
        }
      }
    }
    gfxMap.clear();
    labelMap.clear();
  }, [assetId]);

  // ----- Live-apply the user's "Smooth image" preference. The sampling
  // mode is stamped onto the texture at load time (see the sprite-load
  // block above); this subscription handles the case where the user
  // toggles the setting *after* the image is already loaded so the new
  // mode shows up immediately on the next render.
  useEffect(() => {
    function apply(mode: "linear" | "nearest"): void {
      const app = appRef.current;
      if (!app) return;
      try {
        const layer = app.imageLayer as { children?: unknown[] };
        const sprite = layer.children?.[0] as
          | { texture?: { source?: { scaleMode?: string }; baseTexture?: { scaleMode?: string } } }
          | undefined;
        if (!sprite || !sprite.texture) return;
        if (sprite.texture.source) sprite.texture.source.scaleMode = mode;
        if (sprite.texture.baseTexture) sprite.texture.baseTexture.scaleMode = mode;
      } catch {
        /* best-effort */
      }
    }
    // Initial apply (covers the case where this effect runs after mount
    // but before settings change).
    apply(useEditorSettings.getState().smoothImage ? "linear" : "nearest");
    const unsub = useEditorSettings.subscribe((s, prev) => {
      if (s.smoothImage !== prev.smoothImage) {
        apply(s.smoothImage ? "linear" : "nearest");
      }
    });
    return () => unsub();
  }, [imageSize]);

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

  /**
   * Apply a zoom frame (scale + offset) to the live Pixi layers and
   * mirror it into the refs that hit-testing / pointer math read. This
   * is the only place that touches the scene-graph transform once the
   * canvas is mounted — keeping it centralised guarantees offsetRef and
   * scaleRef never drift from the actual layer transform. v2.6 zoom.
   */
  const applyFrame = useCallback((frame: ZoomFrame) => {
    const app = appRef.current;
    if (!app) return;
    scaleRef.current = frame.scale;
    offsetRef.current = { x: frame.offset.x, y: frame.offset.y };
    [app.imageLayer, app.shapeLayer, app.overlayLayer].forEach((layer) => {
      layer.position.set(frame.offset.x, frame.offset.y);
      layer.scale.set(frame.scale, frame.scale);
    });
    onZoomChange?.(frame.scale * 100);
  }, [onZoomChange]);

  /**
   * Smoothly ease the rendered transform toward `target` over
   * WHEEL_EASE_MS ms using cubic ease-out. Cancels any in-flight ease.
   */
  const easeTo = useCallback(
    (target: ZoomFrame) => {
      easeTargetRef.current = target;
      easeStartRef.current = {
        frame: { scale: scaleRef.current, offset: { ...offsetRef.current } },
        t0: typeof performance !== "undefined" ? performance.now() : Date.now(),
      };
      if (easeRafRef.current !== null) {
        if (typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(easeRafRef.current);
        }
        easeRafRef.current = null;
      }
      const step = (now: number) => {
        const start = easeStartRef.current;
        const goal = easeTargetRef.current;
        if (!start || !goal) {
          easeRafRef.current = null;
          return;
        }
        const elapsed = now - start.t0;
        const t = Math.min(1, elapsed / WHEEL_EASE_MS);
        // Cubic ease-out — fast first, settles to target.
        const k = 1 - Math.pow(1 - t, 3);
        const scale =
          start.frame.scale + (goal.scale - start.frame.scale) * k;
        const ox =
          start.frame.offset.x + (goal.offset.x - start.frame.offset.x) * k;
        const oy =
          start.frame.offset.y + (goal.offset.y - start.frame.offset.y) * k;
        applyFrame({ scale, offset: { x: ox, y: oy } });
        if (t < 1 && typeof requestAnimationFrame === "function") {
          easeRafRef.current = requestAnimationFrame(step);
        } else {
          easeRafRef.current = null;
          easeStartRef.current = null;
          easeTargetRef.current = null;
        }
      };
      if (typeof requestAnimationFrame === "function") {
        easeRafRef.current = requestAnimationFrame(step);
      } else {
        // No rAF (jsdom without polyfill) — apply immediately.
        applyFrame(target);
        easeStartRef.current = null;
        easeTargetRef.current = null;
      }
    },
    [applyFrame],
  );

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
    if (autoFitRef.current) {
      // First load / explicit Fit — recenter on the host with the
      // shrink-to-fit scale.
      const frame = fitToHost({ w: hw, h: hh }, { w: iw, h: ih });
      applyFrame(frame);
    } else {
      // User has zoomed — keep their scale, but recenter the offset so
      // the image stays roughly anchored after a host resize.
      const offset = centeredOffset(
        { w: hw, h: hh },
        { w: iw, h: ih },
        scaleRef.current,
      );
      applyFrame({ scale: scaleRef.current, offset });
    }
  }, [hostSize, imageSize, applyFrame]);

  // ----- Wheel zoom (cursor-anchored). v2.6 zoom.
  //
  // CVAT-style: a bare wheel zooms — there's no horizontal scrollbar to
  // compete with on the canvas. The handler computes the cursor's
  // position inside the host, calls into `zoomAt` to derive the new
  // (scale, offset) pair anchored at that position, and eases toward it
  // so successive notches don't snap.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = host!.getBoundingClientRect();
      const anchor = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
      const factor = wheelDeltaToFactor(e.deltaY);
      if (factor === 1) return;
      autoFitRef.current = false;
      const current: ZoomFrame = {
        scale: scaleRef.current,
        offset: { ...offsetRef.current },
      };
      const next = zoomAt(current, factor, anchor);
      easeTo(next);
    }
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      host.removeEventListener("wheel", onWheel);
    };
  }, [easeTo]);

  // ----- Toolbar / keyboard zoom commands. The toolbar dispatches
  // window CustomEvents (so the toolbar doesn't need a ref into the
  // canvas) and the canvas resolves them against the current frame.
  // v2.6 zoom.
  useEffect(() => {
    function currentFrame(): ZoomFrame {
      return {
        scale: scaleRef.current,
        offset: { ...offsetRef.current },
      };
    }
    function onZoomIn() {
      autoFitRef.current = false;
      const next = zoomCentered(currentFrame(), hostSize, ZOOM_STEP);
      easeTo(next);
    }
    function onZoomOut() {
      autoFitRef.current = false;
      const next = zoomCentered(currentFrame(), hostSize, 1 / ZOOM_STEP);
      easeTo(next);
    }
    function onFit() {
      autoFitRef.current = true;
      const frame = fitToHost(hostSize, imageSize);
      applyFrame(frame);
    }
    function onActual() {
      // 1:1 — image natural pixel size, centered.
      autoFitRef.current = false;
      const offset = centeredOffset(hostSize, imageSize, 1);
      applyFrame({ scale: 1, offset });
    }
    function onZoomTo(e: Event) {
      const detail = (e as CustomEvent<{ pct?: number }>).detail;
      const pct = detail?.pct;
      if (typeof pct !== "number" || !Number.isFinite(pct)) return;
      autoFitRef.current = false;
      const targetScale = clampScale(pct / 100);
      const offset = centeredOffset(hostSize, imageSize, targetScale);
      applyFrame({ scale: targetScale, offset });
    }
    window.addEventListener("carve:zoom-in", onZoomIn);
    window.addEventListener("carve:zoom-out", onZoomOut);
    window.addEventListener("carve:fit-to-screen", onFit);
    window.addEventListener("carve:zoom-actual", onActual);
    window.addEventListener("carve:zoom-to", onZoomTo as EventListener);
    return () => {
      window.removeEventListener("carve:zoom-in", onZoomIn);
      window.removeEventListener("carve:zoom-out", onZoomOut);
      window.removeEventListener("carve:fit-to-screen", onFit);
      window.removeEventListener("carve:zoom-actual", onActual);
      window.removeEventListener("carve:zoom-to", onZoomTo as EventListener);
    };
  }, [easeTo, applyFrame, hostSize, imageSize]);

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
      // Active CVAT-style annotation filter (v2.6). When the tree has at
      // least one rule with a non-empty value, drafts that fail the
      // predicate are forced invisible — same gating path as the legacy
      // `hiddenAnnotationIds` list, just driven by the filter store.
      const filterTree = useFilter.getState().filter;
      const filterApplies = hasMeaningfulRules(filterTree);
      // Build a synthetic ClassRow lookup from the canvas's classNameMap
      // so the evaluator's `label` field can resolve class names. The
      // evaluator only reads `.name`, so we don't need the real ClassRow
      // shape — the cheap cast keeps the evaluator pure.
      const classLookup: Record<string, ClassRow> = {};
      for (const cid of Object.keys(classNames)) {
        classLookup[cid] = { name: classNames[cid] } as unknown as ClassRow;
      }
      for (const draft of sortedDrafts) {
        const id = draft.tempId;
        const filteredOut =
          filterApplies && !evaluateFilter(draft, classLookup, filterTree);
        const hidden =
          state.hiddenAnnotationIds.includes(id) ||
          state.hiddenClassIds.includes(draft.classId) ||
          filteredOut;
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
          // Also hide an existing mask sprite when hidden by visibility.
          const ms = maskSpriteByIdRef.current.get(id);
          if (ms) {
            try {
              (ms.sprite as { visible?: boolean }).visible = false;
            } catch {
              /* ignore */
            }
          }
          seen.add(id);
          continue;
        }
        (g as { visible?: boolean }).visible = true;
        const settings = useEditorSettings.getState();
        // colorBy: "label" → class color (legacy); "instance" → hash of
        // annotation tempId; "group" → amber placeholder (no group support
        // in v1).
        let color: number;
        if (settings.colorBy === "instance") {
          color = colorFromString(id);
        } else if (settings.colorBy === "group") {
          color = DEFAULT_AMBER;
        } else {
          color = hexFromColor(classMap[draft.classId]);
        }
        const fillAlpha = Math.max(0, Math.min(1, settings.opacity / 100));
        const selectedFillAlpha = Math.max(
          0,
          Math.min(1, settings.selectedOpacity / 100),
        );
        const outlineColor = settings.outlinedBorders
          ? hexFromColor(settings.outlinedBorderColor)
          : undefined;
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
            fillAlpha,
            selectedFillAlpha,
            settings.controlPointsSize,
            outlineColor,
          );
          // Class-name tag floating above the bbox top-left when the
          // `labels` flag is on. Skipped when the label flag is off OR no
          // name is known for the class (defensive).
          if (visLabels) {
            const className = classNames[draft.classId];
            const labelText = composeLabelText(draft, className, settings.showLabelText);
            if (labelText) {
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
                  labelText,
                  color,
                  pixiText,
                  pixiContainer,
                  Graphics,
                  settings.labelFontSize,
                  settings.labelPosition,
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
            fillAlpha,
            selectedFillAlpha,
            settings.controlPointsSize,
            outlineColor,
          );
        } else if (draft.geometry.kind === "mask_rle") {
          // Render committed mask annotations as a tinted sprite.
          // The Graphics layer is unused for masks; ensure any prior
          // bbox/polygon graphics in the same gfx slot are cleared.
          (g as { clear?: () => void }).clear?.();
          await renderMaskRleSprite(
            app.shapeLayer as unknown as { addChild: (c: never) => unknown; removeChild?: (c: never) => void },
            maskSpriteByIdRef.current,
            id,
            draft.geometry,
            color,
            isSelected ? selectedFillAlpha : fillAlpha,
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
      // Remove mask sprites whose drafts are gone or no longer
      // mask_rle. Walked separately because masks live in their own map.
      const maskMap = maskSpriteByIdRef.current;
      for (const id of Array.from(maskMap.keys())) {
        const draft = state.byId[id];
        if (!seen.has(id) || !draft || draft.geometry.kind !== "mask_rle") {
          const entry = maskMap.get(id);
          if (entry) {
            try {
              (app.shapeLayer as { removeChild?: (c: never) => void }).removeChild?.(
                entry.sprite as never,
              );
            } catch {
              /* ignore */
            }
            try {
              (entry.sprite as { destroy?: (opts?: unknown) => void }).destroy?.({
                texture: false,
              });
            } catch {
              /* ignore */
            }
            try {
              (entry.texture as { destroy?: () => void }).destroy?.();
            } catch {
              /* ignore */
            }
          }
          maskMap.delete(id);
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
    // Re-render when editor settings change (opacity, colorBy, font size,
    // smoothImage, canvasBgColor — see Settings dialog).
    const unsubS = useEditorSettings.subscribe(() => {
      void reconcile(useAnnotations.getState());
    });
    // Re-render when the active annotation filter changes (v2.6).
    // Without this, applying a filter via the dialog wouldn't trigger
    // a reconcile pass — the canvas would only update on the next
    // unrelated state change.
    const unsubF = useFilter.subscribe(() => {
      void reconcile(useAnnotations.getState());
    });
    return () => {
      mounted = false;
      unsubA();
      unsubT();
      unsubS();
      unsubF();
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

  /**
   * Build (or refresh) the live mask-brush preview sprite. Reads the
   * rasterizer's backing OffscreenCanvas / <canvas> element, wraps it in
   * a Pixi Texture, and blits it onto the overlay layer with a
   * class-color tint at 0.4 alpha so the user can see what they're
   * painting while the stroke is in progress.
   */
  async function drawMaskPreview(
    rasterizerCanvas: unknown,
    color: number,
    alpha: number,
  ) {
    const app = appRef.current;
    if (!app) return;
    let pixi: typeof import("pixi.js") | undefined;
    try {
      pixi = await import("pixi.js");
    } catch {
      return;
    }
    if (!pixi) return;
    let sprite = maskPreviewSpriteRef.current as
      | InstanceType<typeof pixi.Sprite>
      | null;
    let texture = maskPreviewTextureRef.current as
      | InstanceType<typeof pixi.Texture>
      | null;
    if (!sprite || !texture) {
      try {
        // Pixi v8: build a CanvasSource directly so we control its
        // dirty-flag invalidation (the `Texture.from(canvas)` cache
        // path can return a stale texture if the source's bitmap
        // mutates after first import).
        const sourceCtor = (pixi as unknown as { CanvasSource?: new (opts: object) => unknown }).CanvasSource;
        let texSource: unknown = null;
        if (sourceCtor) {
          texSource = new sourceCtor({ resource: rasterizerCanvas });
          texture = new pixi.Texture({ source: texSource as never });
        } else {
          texture = pixi.Texture.from(rasterizerCanvas as TexImageSource);
        }
        sprite = new pixi.Sprite(texture);
        app.overlayLayer.addChild(sprite as never);
        maskPreviewSpriteRef.current = sprite;
        maskPreviewTextureRef.current = texture;
      } catch {
        return;
      }
    }
    // Apply tint + alpha; refresh the texture so the latest pixels appear.
    try {
      (sprite as { tint?: number }).tint = color;
      (sprite as { alpha?: number }).alpha = alpha;
      // Mark the underlying CanvasSource dirty so the GPU texture
      // pulls the latest bitmap on next render.
      const source = (texture as { source?: { update?: () => void } }).source;
      source?.update?.();
    } catch {
      /* ignore — preview is best-effort */
    }
  }

  function clearMaskPreview() {
    const app = appRef.current;
    const sprite = maskPreviewSpriteRef.current as
      | { destroy?: (opts?: unknown) => void }
      | null;
    if (app && sprite) {
      try {
        app.overlayLayer.removeChild(sprite as never);
      } catch {
        /* ignore */
      }
      try {
        sprite.destroy?.({ texture: false });
      } catch {
        /* ignore */
      }
    }
    maskPreviewSpriteRef.current = null;
    const tex = maskPreviewTextureRef.current as
      | { destroy?: () => void }
      | null;
    try {
      tex?.destroy?.();
    } catch {
      /* ignore */
    }
    maskPreviewTextureRef.current = null;
  }

  // ----- Tool routing — recreate per render-relevant change.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const idGen = () => `t-${Math.random().toString(36).slice(2, 11)}`;
    const getClass = () => activeClassId;
    const getFrame = () => frameId;
    const getSize = () => imageSize;

    // Pass an image-size getter to the tools so they can clamp pointer
    // coordinates to the image rectangle on every event. v2.5.2 — without
    // this, dragging past the canvas backdrop produced bbox / polygon
    // geometry far outside the image.
    const bbox = new BboxTool(getClass, getFrame, idGen, getSize);
    const polygon = new PolygonTool(getClass, getFrame, idGen, getSize);
    // Initial brush radius pulls from the store; live changes from the
    // brush-size slider keep the tool in sync via the subscribe below.
    const mask = new MaskBrushTool(
      getClass,
      getFrame,
      getSize,
      useTool.getState().maskBrushRadius,
      idGen,
    );
    const unsubMaskRadius = useTool.subscribe((s, prev) => {
      if (s.maskBrushRadius !== prev.maskBrushRadius) {
        mask.setRadius(s.maskBrushRadius);
      }
    });
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
      else if (tool === "mask") {
        mask.onPointerDown(p, e.button);
        const r = mask.getRasterizer();
        if (r) {
          const cls = useTool.getState().activeClassId;
          const color = hexFromColor(cls ? classMap[cls] : undefined);
          void drawMaskPreview(r.getCanvas(), color, 0.4);
        }
      }
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
        const r = mask.getRasterizer();
        if (r) {
          const cls = useTool.getState().activeClassId;
          const color = hexFromColor(cls ? classMap[cls] : undefined);
          void drawMaskPreview(r.getCanvas(), color, 0.4);
        }
      } else if (tool === "cursor") {
        const drag = dragRef.current;
        if (drag) {
          // Active drag — translate or resize the selected bbox, or move
          // a polygon vertex (Phase A core 3). Pass the live image size so
          // the geometry can never escape the image (v2.5.2). When the
          // image hasn't loaded yet (size 1×1 sentinel from initial state)
          // we still pass it — clamping a 1×1 bound just keeps everything
          // sane until the texture lands.
          const bounds = imageSize.w > 1 && imageSize.h > 1 ? imageSize : null;
          if (drag.mode === "translate") {
            const next = applyTranslate(
              drag.original,
              p.x - drag.offset.x,
              p.y - drag.offset.y,
              bounds,
            );
            useAnnotations.getState().update(drag.id, { geometry: next });
          } else if (drag.mode === "resize") {
            const next = applyResize(drag.original, drag.handle, p, bounds);
            useAnnotations.getState().update(drag.id, { geometry: next });
          } else {
            // mode === "vertex"
            const next = applyVertexTranslate(drag.original, drag.index, p, bounds);
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
            const bounds = imageSize.w > 1 && imageSize.h > 1 ? imageSize : null;
            const next = applyTranslate(
              sel.bbox,
              sel.bbox.x + dx,
              sel.bbox.y + dy,
              bounds,
            );
            useAnnotations.getState().update(sel.id, { geometry: next });
            return;
          }
        }
      }
      if (tool === "polygon") {
        const r = polygon.onKeyDown(e.key);
        if (r.committed || r.cancelled) clearPolygonPreview();
      }
      else if (tool === "mask") {
        const r = mask.onKeyDown(e.key);
        if (e.key === "[" || e.key === "]") {
          // Mirror the new radius back to the store so the toolbar
          // slider reflects keyboard adjustments.
          useTool.getState().setMaskBrushRadius(mask.getRadius());
        }
        if (r.committed || r.cancelled) clearMaskPreview();
      }
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
      // Likewise for in-flight mask brush strokes.
      mask.cancel();
      clearMaskPreview();
      unsubMaskRadius();
    };
  }, [tool, activeClassId, frameId, imageSize, samTool, classMap]);

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

  // Subscribe to canvas bg color + pattern so changes from Settings → Player
  // apply immediately. Selecting from the store ensures a re-render on change.
  const canvasBg = useEditorSettings((s) => s.canvasBgColor);
  const canvasPattern = useEditorSettings((s) => s.canvasPattern);

  return (
    <div
      ref={hostRef}
      role="region"
      aria-label={`Annotation canvas (${tool})`}
      className="canvas-checker"
      data-pattern={canvasPattern === "none" ? undefined : canvasPattern}
      style={{
        position: "absolute",
        inset: 0,
        cursor: dragCursor ?? toolCursor(tool),
        overflow: "hidden",
        touchAction: "none",
        backgroundColor: canvasBg,
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
        classes={classesProp}
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
  labelText: string,
  color: number,
  TextCtor: typeof import("pixi.js").Text,
  ContainerCtor: typeof import("pixi.js").Container,
  GraphicsCtor: typeof import("pixi.js").Graphics,
  fontSize = 11,
  position: "auto" | "above" | "below" | "left" | "right" = "auto",
): void {
  let entry = labelMap.get(id);
  if (!entry) {
    const container = new ContainerCtor();
    const bg = new GraphicsCtor();
    const text = new TextCtor({
      text: labelText,
      style: {
        fontFamily: "Inter, system-ui, sans-serif",
        fontSize: fontSize,
        fill: 0xffffff,
        fontWeight: "500",
        // Multi-line label content (id + label) needs explicit alignment;
        // pixi defaults to left, which is what we want here.
        align: "left",
      },
    });
    (container as unknown as AddChildSink).addChild(bg as never);
    (container as unknown as AddChildSink).addChild(text as never);
    layer.addChild(container as never);
    entry = { container, bg, text };
    labelMap.set(id, entry);
  }
  // Update text content if changed.
  const text = entry.text as {
    text: string;
    width: number;
    height: number;
    style: { fontSize: number };
  };
  if (text.text !== labelText) text.text = labelText;
  // Update font size if it diverged (Settings → labelFontSize).
  try {
    if (text.style && text.style.fontSize !== fontSize) {
      text.style.fontSize = fontSize;
    }
  } catch {
    /* style may be readonly in some pixi versions; ignore */
  }
  // Lay out: tag dimensions follow the (possibly multi-line) text.
  const padX = 4;
  const padY = 2;
  const tw = text.width + padX * 2;
  const th = text.height + padY * 2;
  // Position the container relative to the bbox per the user's preference.
  // `auto` matches the legacy behaviour (above the top-left corner).
  const gap = 4;
  let cx: number;
  let cy: number;
  switch (position) {
    case "below":
      cx = bbox.x;
      cy = bbox.y + bbox.h + gap;
      break;
    case "left":
      cx = bbox.x - tw - gap;
      cy = bbox.y;
      break;
    case "right":
      cx = bbox.x + bbox.w + gap;
      cy = bbox.y;
      break;
    case "above":
    case "auto":
    default:
      cx = bbox.x;
      cy = bbox.y - th - gap;
      break;
  }
  const container = entry.container as { position: { set: (x: number, y: number) => void } };
  container.position.set(cx, cy);
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

/**
 * Compose the label text shown above each annotation based on the
 * Settings → "Label text" checkboxes. Returns ``""`` when no field
 * applies; the caller skips rendering in that case.
 *
 * - Label: class name (legacy default)
 * - ID: short uuid prefix (8 chars) of the annotation tempId
 * - Source: "manual" placeholder for v1 (annotations have no provenance
 *   field yet)
 * - Attributes / Descriptions: stub strings until the data model gains
 *   first-class fields. Visible so the user can see the option works.
 */
function composeLabelText(
  draft: AnnotationDraft,
  className: string | undefined,
  flags: {
    id: boolean;
    source: boolean;
    label: boolean;
    attributes: boolean;
    descriptions: boolean;
  },
): string {
  const parts: string[] = [];
  if (flags.label && className) parts.push(className);
  if (flags.id) parts.push(`#${draft.tempId.slice(0, 8)}`);
  if (flags.source) parts.push("manual");
  if (flags.attributes) parts.push("(no attrs)");
  if (flags.descriptions) parts.push("(no desc)");
  return parts.join("\n");
}

/**
 * Render a committed `mask_rle` annotation as a tinted sprite. We decode
 * the RLE into a binary mask once, draw it onto an HTMLCanvas (white
 * pixels where 1, transparent elsewhere), then wrap that canvas in a
 * Pixi Texture + Sprite. Tint applies the class color; alpha is the
 * caller's fill opacity (selected vs idle).
 */
async function renderMaskRleSprite(
  layer: { addChild: (c: never) => unknown; removeChild?: (c: never) => void },
  spriteMap: Map<string, { sprite: unknown; canvas: HTMLCanvasElement; texture: unknown }>,
  id: string,
  geometry: { kind: "mask_rle"; size: [number, number]; counts: string },
  color: number,
  alpha: number,
): Promise<void> {
  let pixi: typeof import("pixi.js") | undefined;
  try {
    pixi = await import("pixi.js");
  } catch {
    return;
  }
  if (!pixi) return;
  let entry = spriteMap.get(id);
  const [h, w] = geometry.size;
  if (!entry) {
    // Build a fresh canvas + sprite for this annotation. Decoding a mask
    // is expensive; we cache the canvas per-annotation. The `geometry`
    // is immutable per annotation in v1 (mask edits commit a new one),
    // so we don't need to invalidate when the draft updates.
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    try {
      const { decodeRLE } = await import("@/canvas/maskio");
      const mask = decodeRLE(geometry.counts, h, w);
      const img = ctx.createImageData(w, h);
      const data = img.data;
      for (let row = 0; row < h; row += 1) {
        for (let col = 0; col < w; col += 1) {
          const i = (row * w + col) * 4;
          if (mask[row * w + col]) {
            data[i] = 255;
            data[i + 1] = 255;
            data[i + 2] = 255;
            data[i + 3] = 255;
          }
        }
      }
      ctx.putImageData(img, 0, 0);
    } catch {
      return;
    }
    let texture: InstanceType<typeof pixi.Texture>;
    try {
      texture = pixi.Texture.from(cv);
    } catch {
      return;
    }
    const sprite = new pixi.Sprite(texture);
    layer.addChild(sprite as never);
    entry = { sprite, canvas: cv, texture };
    spriteMap.set(id, entry);
  }
  // Apply tint + alpha.
  try {
    (entry.sprite as { tint?: number; alpha?: number; visible?: boolean }).tint = color;
    (entry.sprite as { tint?: number; alpha?: number; visible?: boolean }).alpha = alpha;
    (entry.sprite as { tint?: number; alpha?: number; visible?: boolean }).visible = true;
  } catch {
    /* ignore — sprite tint/alpha are best-effort */
  }
}

/**
 * Map the active tool to a CSS cursor. Each tool gets a distinct cursor
 * so the active tool is always visible without looking at the toolbar.
 *
 * - cursor (V): default
 * - bbox (B), polygon (P), mask (M), tag (T): crosshair
 * - sam (S): cell — emphasises the click-to-segment intent
 * - rectangle move (R, future): move
 */
function toolCursor(t: ToolName): string {
  switch (t) {
    case "bbox":
    case "polygon":
    case "mask":
    case "tag":
      return "crosshair";
    case "sam":
      return "cell";
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
