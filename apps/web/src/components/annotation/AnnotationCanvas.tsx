import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

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
import { useSamTrackBridge, type SamTrackMarker } from "@/state/samTrackBridge";
import { useReviewCompare } from "@/state/reviewCompare";
import { evaluateFilter, hasMeaningfulRules } from "@/lib/annotation-filter";
import { classesApi, type ClassRow } from "@/api/classes";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
  hitTestEdge,
  hitTestVertex,
  insertVertex,
  shouldShowEdgeGhost,
} from "@/canvas/polygonEdit";
import { showToast } from "@/lib/toast";
import { CrosshairOverlay } from "@/components/annotation/CrosshairOverlay";
import { AnnotationContextMenu } from "@/components/annotation/AnnotationContextMenu";
import { ModelLoadingOverlay } from "@/components/annotation/ModelLoadingOverlay";
import { ClassCommandPalette } from "@/components/annotation/ClassCommandPalette";
import {
  centeredOffset,
  clampScale,
  fitToHost,
  panBy,
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
  // v3.2 Issue 1: tracks the assetId of the last successfully loaded
  // texture so we only re-arm autoFit when the *asset* changes — not
  // when the same asset's presigned MinIO URL is re-signed (which
  // happens on every assetQ refetch / window-focus). Keying autoFit on
  // the URL string would silently kill the user's zoom every time they
  // tabbed back to the editor.
  const prevAssetIdRef = useRef<string | null>(null);
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
  // v3.5 Phase C — when SAM activate() takes longer than the threshold
  // (typical first-encode after a model load), surface a progress
  // overlay polling /models/sam-status. ``samLoadOverlayOpen`` is the
  // single source of truth; we open on a 2s timer and close on activate
  // resolve so quick activations (warm session) never flash the overlay.
  const [samLoadOverlayOpen, setSamLoadOverlayOpen] = useState(false);
  const shapeGfxByIdRef = useRef<Map<string, unknown>>(new Map());
  // Plan-09 Phase 5 Task 4 — graphics nodes for the prev-geometry
  // compare overlay (one Graphics per id). Kept in a separate map so
  // the main shape pipeline can clear/reconcile its own `gfxMap`
  // without destroying the compare overlay (and vice versa).
  const compareGfxByIdRef = useRef<Map<string, unknown>>(new Map());
  // Plan-09b Task 2 — single Graphics instance for the alt+hover edge-
  // insert ghost dot. Lazily created on first paint so pure-pixi mocks
  // that don't expose Graphics (e.g. v3.2 canvas-pan) don't crash.
  const ghostEdgeGfxRef = useRef<unknown | null>(null);
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
  // v3.5 Phase D — in-flight box draft for SAM ``box`` mode. Mirrors
  // BboxTool's anchor/current pair; lives in a ref so the tool-routing
  // useEffect doesn't recreate on every move event.
  const samBoxDraftRef = useRef<{ anchor: Point; current: Point } | null>(null);
  // v3.8 Phase 4-video step F7 — bbox-seed drag in Track mode. On
  // pointerdown we start a draft; on pointerup a small drag falls back
  // to a positive-click prompt and a real drag is forwarded as a box
  // prompt to the panel's box handler.
  const samTrackBoxDraftRef = useRef<{ anchor: Point; current: Point } | null>(null);
  // Plan 14 Phase 8 Task 7 — cursor-tool marquee (drag-rectangle) selection.
  // ``shift`` snapshot is captured at pointerdown so a release that no
  // longer carries shiftKey (rare on jsdom) still respects the original
  // intent. ``startClient`` is used to compute the drag distance (so a
  // sub-4px drag falls back to the click-to-select path).
  const marqueeDraftRef = useRef<
    | {
        anchor: Point;
        current: Point;
        shift: boolean;
        startClient: { x: number; y: number };
      }
    | null
  >(null);
  // Separate Graphics so the marquee outline doesn't fight the bbox
  // preview rect. Lazily created on first paint.
  const marqueeGfxRef = useRef<unknown | null>(null);
  // Mirror of the ``samMode`` zustand slice so the tool-routing useEffect
  // can branch on it without re-running on every keystroke. We keep it as
  // a separate state read so React re-renders the floating text input
  // (which is JSX, not Pixi).
  const samMode = useTool((s) => s.samMode);
  const [samTextDraft, setSamTextDraft] = useState("");
  const [samTextPending, setSamTextPending] = useState(false);
  // v3.8 Phase 3.6 — Class Command Palette open state. Opens via "/"
  // when a SAM candidate is active (or, future, polygon/bbox candidate).
  // Plan 14 Phase 8 Task 4 — productized: now drives the universal
  // set-active / reassign palette. ``mode`` selects between picking the
  // next active class (``/`` and Cmd-Shift-C) and bulk-reassigning the
  // current selection (``R`` and the type-to-filter flow from Task 5).
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<"set-active" | "reassign">(
    "set-active",
  );
  const [paletteInitialQuery, setPaletteInitialQuery] = useState("");
  // v3.8 Phase 3.7 — when true, Apply commits every result above
  // SAM_TEXT_FIND_ALL_THRESHOLD as a polygon (or mask) annotation
  // straight to the active class. Default true: addresses the user's
  // "3 people but only 1 found" expectation.
  const [samTextFindAll, setSamTextFindAll] = useState(true);
  // v3.2 Issue 2: canvas-pan affordances. `spacePanRef` tracks whether
  // Space is held (enables click-drag pan regardless of active tool);
  // `panActiveRef` tracks whether a pan drag is in flight (Space+drag
  // OR middle-mouse drag); `panOriginRef` snapshots the pointer's
  // client position + the frame offset at pan-start so move events
  // produce deltas relative to a stable origin instead of the previous
  // event. Without these, a zoomed-in image had no way to scroll.
  const spacePanRef = useRef(false);
  const panActiveRef = useRef(false);
  const panOriginRef = useRef<{
    clientX: number;
    clientY: number;
    startOffset: { x: number; y: number };
  } | null>(null);
  // Reset the dragCursor whenever the active tool changes. Otherwise a
  // pending hover-cursor (e.g. "ew-resize" from hovering a bbox handle
  // while the cursor tool was active) sticks across V→B / B→V toggles
  // because only the cursor-tool branch of onMove clears it. v2.7
  // wave 2 item 5.
  useEffect(() => {
    setDragCursor(null);
    // Plan 14 Phase 8 Task 7 — flushing tool state should also drop any
    // in-flight marquee draft so flipping cursor → bbox mid-drag never
    // leaves a stale outline floating on the overlay.
    marqueeDraftRef.current = null;
    clearMarquee();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);
  // v3.5 Phase D — keep the SamTool instance's mode in sync with the
  // toolbar picker. Decoupling via the store (rather than a prop) keeps
  // the EditorToolbar from importing the canvas's SamTool instance.
  useEffect(() => {
    samTool.setMode(samMode);
    // Clear any in-flight box drag / draft text when the user flips
    // modes mid-interaction. v3.6 — also drop the live mask preview +
    // point markers so a stale mask from the previous mode never lingers.
    samBoxDraftRef.current = null;
    samTrackBoxDraftRef.current = null;
    // v3.8 Phase 3 — leaving Text mode clears the draft. We DO NOT
    // auto-fill on entry: the user controls their input. The "Use
    // class prompt" button on the floating panel is the explicit
    // opt-in path for copying a class's stored prompt.
    if (samMode !== "text") setSamTextDraft("");
    clearSamPreview();
    clearSamPoints();
    // v3.8 Phase 2 — drop any persistent SAM-box outline when leaving
    // box mode so it doesn't render under Point / Track flows.
    clearPreview();
    // Track-mode markers belong to the SamTrack panel, not the SamTool.
    // Tear them down whenever the user leaves track mode so leftover
    // markers don't follow them into point/box/text flows.
    if (samMode !== "track") clearSamTrackMarkers();
    else void drawSamTrackMarkers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samMode, samTool]);

  // v3.8 Phase 3 — class auto-fill removed. The "Use class prompt"
  // button on the floating Text panel is the explicit way to copy the
  // active class's stored text_prompt into the input.

  // Subscribe to bridge marker changes so the canvas re-paints whenever
  // <SamTrackPanel> publishes a new markers array (after addObjectAtFrame).
  useEffect(() => {
    const unsub = useSamTrackBridge.subscribe((s, prev) => {
      if (s.markers === prev.markers) return;
      // Only paint when track mode is active — otherwise we'd draw on
      // top of a non-track UX.
      if (useTool.getState().samMode === "track") {
        void drawSamTrackMarkers();
      }
    });
    return () => {
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
  // v3.6 SAM live preview — analogous to the mask brush preview but
  // sourced from the latest decode/box/text RLE result. Held in their
  // own refs so the mask brush preview cleanup never tears down the SAM
  // preview and vice-versa. The backing canvas is reused across decodes
  // when the size matches so we don't churn GPU textures on every click.
  const samMaskPreviewSpriteRef = useRef<unknown | null>(null);
  const samMaskPreviewTextureRef = useRef<unknown | null>(null);
  const samMaskPreviewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Per-click point markers (positives + negatives) drawn on top of the
  // mask preview so the user can see exactly where they clicked. v3.6.
  const samPointsGfxRef = useRef<unknown | null>(null);
  // v3.6 — numbered markers for SAM video tracking objects. Rendered on
  // the overlay layer when the SAM tool + track mode are active. Each
  // entry is a Pixi Container holding a circle + text label so we can
  // tear them down individually when the panel resets.
  const samTrackMarkersGfxRef = useRef<unknown[]>([]);
  // Per-annotation label tag (a Pixi Container holding a fill rect + Text).
  // Rendered above each bbox when the `labels` visibility flag is on.
  // Audit bug O.
  const labelGfxByIdRef = useRef<
    Map<string, { container: unknown; text: unknown; bg: unknown; check?: unknown }>
  >(
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

    // Reset auto-fit so each new asset arrives centred + fit-to-host. The
    // user complaint: navigating between assets used to inherit the
    // previous asset's zoom level (because wheel/+/− zooms set
    // autoFitRef to false, and only an explicit Fit click flipped it
    // back). v2.9 P0-2: previously this flag was set synchronously
    // BEFORE the await Assets.load — but a host-resize between flag-set
    // and texture-load could trigger fit-to-host using the *previous*
    // imageSize. We now flip the flag AFTER setImageSize in the success
    // branch, and we capture the prior value so the catch (error) path
    // can restore it instead of leaving a stale `true`. (P1-12.)
    const priorAutoFit = autoFitRef.current;

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
        // P0-2: only re-arm auto-fit AFTER the new dimensions are pushed
        // into state. A host-resize between the imageUrl change and the
        // texture-load can no longer fit to the previous imageSize.
        //
        // v3.2 Issue 1: gate the re-arm on assetId change — not URL change.
        // A presigned MinIO URL re-sign (assetQ refetch on window focus)
        // produces a new imageUrl string for the SAME asset; flipping
        // autoFit there would silently throw away the user's zoom on
        // every tab-back. Different asset → still refits correctly.
        if (assetId !== prevAssetIdRef.current) {
          autoFitRef.current = true;
          prevAssetIdRef.current = assetId;
        }
        onImageStatusChange?.("loaded");
      } catch (e) {
        if (cancelled) return;
        // P1-12: restore the prior auto-fit value on error so a failed
        // load doesn't strand `autoFitRef` in an unexpected state.
        autoFitRef.current = priorAutoFit;
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
    const compareMap = compareGfxByIdRef.current;
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
      for (const g of compareMap.values()) {
        try {
          app.shapeLayer.removeChild(g as never);
        } catch {
          /* ignore */
        }
      }
    }
    gfxMap.clear();
    labelMap.clear();
    compareMap.clear();
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

  // ----- Wheel zoom (cursor-anchored). v2.7 wave 2 item 6 — smooth.
  //
  // CVAT-style: a bare wheel zooms — there's no horizontal scrollbar to
  // compete with on the canvas. The handler accumulates deltaY into a
  // ref between rAF ticks so high-frequency trackpad pinches (60-120 Hz)
  // collapse into one zoom step per frame, anchored at the most recent
  // pointer position. The factor uses the now-proportional
  // ``wheelDeltaToFactor`` so |deltaY| controls magnitude smoothly. We
  // skip the previous 60 ms cubic ease — with proportional math the
  // ease was fighting the input rather than smoothing it.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let pendingDeltaY = 0;
    let lastAnchor: { x: number; y: number } | null = null;
    let rafId: number | null = null;

    function flush() {
      rafId = null;
      const dy = pendingDeltaY;
      const anchor = lastAnchor;
      pendingDeltaY = 0;
      lastAnchor = null;
      if (dy === 0 || !anchor) return;
      const factor = wheelDeltaToFactor(dy);
      if (factor === 1) return;
      autoFitRef.current = false;
      const current: ZoomFrame = {
        scale: scaleRef.current,
        offset: { ...offsetRef.current },
      };
      const next = zoomAt(current, factor, anchor);
      applyFrame(next);
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = host!.getBoundingClientRect();
      lastAnchor = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
      pendingDeltaY += e.deltaY;
      if (rafId === null) {
        if (typeof requestAnimationFrame === "function") {
          rafId = requestAnimationFrame(flush);
        } else {
          // jsdom / no rAF — apply immediately.
          flush();
        }
      }
    }

    host.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      host.removeEventListener("wheel", onWheel);
      if (rafId !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafId);
      }
      rafId = null;
      pendingDeltaY = 0;
      lastAnchor = null;
    };
  }, [applyFrame]);

  // ----- Space-hold pan toggle. v3.2 Issue 2.
  //
  // When Space is held, the canvas enters a "pan-armed" state — the
  // host cursor flips to "grab" and the pointer-down handler intercepts
  // before the active tool, starting a drag that pans the layer offset.
  // Space release clears the armed state. We attach to `window` (rather
  // than the host) so the toggle works whether or not the host has
  // focus, but we still respect target tag so Space typed into the nav
  // search box / a text area / a contenteditable doesn't hijack the
  // page's normal scroll-on-Space behaviour.
  useEffect(() => {
    function isEditableTarget(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null;
      if (!el || typeof el !== "object") return false;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true;
      if (el.isContentEditable) return true;
      return false;
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.code !== "Space" && e.key !== " ") return;
      if (isEditableTarget(e.target)) return;
      // Avoid stomping on key-repeat: only flip the cursor / preventDefault
      // on the first transition. Holding Space still keeps the ref true.
      e.preventDefault();
      if (!spacePanRef.current) {
        spacePanRef.current = true;
        // Don't override an active drag's grabbing cursor.
        if (!panActiveRef.current) setDragCursor("grab");
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code !== "Space" && e.key !== " ") return;
      spacePanRef.current = false;
      if (!panActiveRef.current) setDragCursor(null);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  // ----- Plan 09 Task 10 — cheat-sheet hotkey ('?' / Shift+/).
  //
  // Lifted out of <KeyboardCheatSheet> so the binding only exists when
  // the editor canvas is mounted (no global '?' hijack on other pages).
  // Dispatches a CustomEvent the cheat-sheet dialog listens for; we
  // skip the binding when an input / textarea / contenteditable has
  // focus so users typing a literal '?' aren't interrupted.
  useEffect(() => {
    function isEditableTarget(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null;
      if (!el || typeof el !== "object") return false;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true;
      if (el.isContentEditable) return true;
      return false;
    }
    function onKey(e: KeyboardEvent) {
      if (isEditableTarget(e.target)) return;
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("carve:open-cheat-sheet"));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    function onOpenPalette(e: Event) {
      const detail = (e as CustomEvent<{ mode?: "set-active" | "reassign" }>)
        .detail;
      const mode = detail?.mode ?? "set-active";
      setPaletteMode(mode);
      setPaletteInitialQuery("");
      setPaletteOpen(true);
    }
    window.addEventListener("carve:zoom-in", onZoomIn);
    window.addEventListener("carve:zoom-out", onZoomOut);
    window.addEventListener("carve:fit-to-screen", onFit);
    window.addEventListener("carve:zoom-actual", onActual);
    window.addEventListener("carve:zoom-to", onZoomTo as EventListener);
    window.addEventListener(
      "carve:open-class-palette",
      onOpenPalette as EventListener,
    );
    return () => {
      window.removeEventListener("carve:zoom-in", onZoomIn);
      window.removeEventListener("carve:zoom-out", onZoomOut);
      window.removeEventListener("carve:fit-to-screen", onFit);
      window.removeEventListener("carve:zoom-actual", onActual);
      window.removeEventListener("carve:zoom-to", onZoomTo as EventListener);
      window.removeEventListener(
        "carve:open-class-palette",
        onOpenPalette as EventListener,
      );
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
          // Plan 14 Phase 8 Task 6 — per-annotation colorOverride wins
          // when set; otherwise fall back to the class color.
          color = hexFromColor(draft.colorOverride ?? classMap[draft.classId]);
        }
        // Plan-09 Phase 5 Task 3 — rejected annotations render dimmed
        // so the reviewer can SEE at a glance which proposals are
        // discarded without hiding them entirely (still selectable /
        // editable, can be un-rejected from the panel).
        const rejectedAlphaMul = draft.status === "rejected" ? 0.4 : 1;
        const fillAlpha = Math.max(
          0,
          Math.min(1, (settings.opacity / 100) * rejectedAlphaMul),
        );
        const selectedFillAlpha = Math.max(
          0,
          Math.min(1, (settings.selectedOpacity / 100) * rejectedAlphaMul),
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
                  draft.status ?? "proposed",
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

      // ----- Plan-09 Phase 5 Task 4 — prev-revision compare overlay -----
      // Iterate the union of pinned + hovered ids from the compare
      // bridge slice. For each draft with a non-null ``prevGeometry``
      // we paint a translucent extra layer on top of the main shape:
      //
      //   * bbox / polygon → dashed outline at 50% alpha of the row's
      //     class colour. Pixi's Graphics has no native dashed stroke
      //     so we hand-roll a segment loop.
      //   * mask_rle → dashed outline doesn't make sense for a raster
      //     mask. We render the prev mask as a 30% alpha solid in the
      //     same class colour (pragmatic v1; documented limitation).
      //
      // The overlay ALWAYS uses the row's class colour even when the
      // user has switched colorBy to "instance" / "group" — the goal
      // is to compare geometries, not to colour-code instances.
      const compareState = useReviewCompare.getState();
      const compareIds = new Set<string>([
        ...compareState.pinned,
        ...compareState.hovered,
      ]);
      const compareMap = compareGfxByIdRef.current;
      const compareSeen = new Set<string>();
      for (const id of compareIds) {
        const draft = state.byId[id];
        if (!draft) continue;
        const prev = draft.prevGeometry as
          | { kind?: string; x?: number; y?: number; w?: number; h?: number;
              points?: Array<[number, number]>;
              counts?: string; size?: [number, number] }
          | null
          | undefined;
        if (!prev || !prev.kind) continue;
        const color = hexFromColor(classMap[draft.classId]);
        if (prev.kind === "bbox" && typeof prev.x === "number" &&
            typeof prev.y === "number" && typeof prev.w === "number" &&
            typeof prev.h === "number") {
          let cg = compareMap.get(id) as InstanceType<typeof Graphics> | undefined;
          if (!cg || !(cg as { clear?: unknown }).clear) {
            // Existing entry isn't a Graphics (maybe a previous mask sprite).
            // Drop it and start fresh.
            if (cg) {
              try { app.shapeLayer.removeChild(cg as never); } catch { /* ignore */ }
            }
            cg = new Graphics();
            compareMap.set(id, cg);
            app.shapeLayer.addChild(cg);
          }
          cg.clear();
          drawDashedRect(cg, prev.x, prev.y, prev.w, prev.h, color);
          compareSeen.add(id);
        } else if (prev.kind === "polygon" && Array.isArray(prev.points) &&
                   prev.points.length > 0) {
          let cg = compareMap.get(id) as InstanceType<typeof Graphics> | undefined;
          if (!cg || !(cg as { clear?: unknown }).clear) {
            if (cg) {
              try { app.shapeLayer.removeChild(cg as never); } catch { /* ignore */ }
            }
            cg = new Graphics();
            compareMap.set(id, cg);
            app.shapeLayer.addChild(cg);
          }
          cg.clear();
          drawDashedPolygon(cg, prev.points, color);
          compareSeen.add(id);
        } else if (prev.kind === "mask_rle" && typeof prev.counts === "string" &&
                   Array.isArray(prev.size) && prev.size.length === 2) {
          // Paint the prev mask as a translucent class-coloured sprite.
          // Mount lazily; reuse the cached sprite when the same id is
          // hovered/pinned across reconciles.
          const existing = compareMap.get(id);
          if (!existing) {
            // Build async; mark as seen so the cleanup pass below doesn't
            // immediately drop the placeholder. We add the sprite to the
            // map only after the texture is built.
            void paintCompareMaskSprite(
              app.shapeLayer as unknown as {
                addChild: (c: never) => unknown;
                removeChild?: (c: never) => void;
              },
              compareMap,
              id,
              prev.counts,
              prev.size as [number, number],
              color,
            );
          }
          compareSeen.add(id);
        }
      }
      // Drop compare graphics whose id is no longer in the union.
      for (const id of Array.from(compareMap.keys())) {
        if (!compareSeen.has(id)) {
          const g = compareMap.get(id) as InstanceType<typeof Graphics> | undefined;
          if (g) {
            try {
              app.shapeLayer.removeChild(g as never);
            } catch {
              /* ignore */
            }
          }
          compareMap.delete(id);
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
    // Plan-09 Phase 5 Task 4 — re-render when the prev-revision compare
    // bridge (hovered / pinned ids) changes. Subscribed here so a
    // hover-on/off in <ReviewPanel> repaints the dashed overlay.
    const unsubC = useReviewCompare.subscribe(() => {
      void reconcile(useAnnotations.getState());
    });
    return () => {
      mounted = false;
      unsubA();
      unsubT();
      unsubS();
      unsubF();
      unsubC();
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

  // ----- Plan 14 Phase 8 Task 7 — marquee preview rectangle.
  async function drawMarqueeRect(rect: {
    x: number;
    y: number;
    w: number;
    h: number;
  }) {
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
    let g = marqueeGfxRef.current as InstanceType<typeof Graphics> | null;
    if (!g) {
      g = new Graphics();
      marqueeGfxRef.current = g;
      app.overlayLayer.addChild(g);
    }
    g.clear();
    g.rect(rect.x, rect.y, rect.w, rect.h);
    // Lighter / dashed-feel stroke vs drawPreviewRect — visually distinct
    // so the user knows this is a selection marquee, not a draft bbox.
    g.stroke({ color: 0x60a5fa, width: 1, alpha: 0.95 });
    g.fill({ color: 0x60a5fa, alpha: 0.08 });
  }

  function clearMarquee() {
    const g = marqueeGfxRef.current as { clear?: () => void } | null;
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

  /**
   * v3.6 SAM live preview helper — decode the SAM RLE result into a
   * binary mask, paint white-on-transparent pixels onto an HTML canvas,
   * then wrap it in a Pixi Sprite (tinted to the active class color)
   * so the user sees the prospective mask before pressing Enter.
   *
   * Mirrors `drawMaskPreview` (mask brush) but the source canvas is
   * built from the RLE rather than from a MaskRasterizer; we maintain
   * a single canvas/texture/sprite triple keyed off the SAM ref bag,
   * recreating it only when the mask size changes.
   */
  async function drawSamMaskPreview(
    counts: string,
    size: [number, number],
    color: number,
    alpha = 0.45,
  ): Promise<void> {
    const app = appRef.current;
    if (!app) return;
    let pixi: typeof import("pixi.js") | undefined;
    try {
      pixi = await import("pixi.js");
    } catch {
      return;
    }
    if (!pixi) return;
    const [h, w] = size;
    if (h <= 0 || w <= 0) return;
    // Reuse the canvas when its dimensions match — the GPU texture stays
    // valid across decodes if we mark its source dirty after redrawing.
    let canvas = samMaskPreviewCanvasRef.current;
    let recreate = false;
    if (!canvas || canvas.width !== w || canvas.height !== h) {
      canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      samMaskPreviewCanvasRef.current = canvas;
      recreate = true;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Decode RLE and paint white-on-transparent.
    try {
      const { decodeRLE } = await import("@/canvas/maskio");
      const mask = decodeRLE(counts, h, w);
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
    let sprite = samMaskPreviewSpriteRef.current as
      | InstanceType<typeof pixi.Sprite>
      | null;
    let texture = samMaskPreviewTextureRef.current as
      | InstanceType<typeof pixi.Texture>
      | null;
    if (recreate || !sprite || !texture) {
      // Tear down any prior sprite/texture; the size changed so the GPU
      // resources are no longer valid.
      if (sprite && app) {
        try {
          app.overlayLayer.removeChild(sprite as never);
        } catch {
          /* ignore */
        }
        try {
          (sprite as { destroy?: (opts?: unknown) => void }).destroy?.({
            texture: false,
          });
        } catch {
          /* ignore */
        }
      }
      if (texture) {
        try {
          (texture as { destroy?: () => void }).destroy?.();
        } catch {
          /* ignore */
        }
      }
      try {
        const sourceCtor = (
          pixi as unknown as { CanvasSource?: new (opts: object) => unknown }
        ).CanvasSource;
        if (sourceCtor) {
          const texSource = new sourceCtor({ resource: canvas });
          texture = new pixi.Texture({ source: texSource as never });
        } else {
          texture = pixi.Texture.from(canvas as TexImageSource);
        }
        sprite = new pixi.Sprite(texture);
        app.overlayLayer.addChild(sprite as never);
        samMaskPreviewSpriteRef.current = sprite;
        samMaskPreviewTextureRef.current = texture;
      } catch {
        return;
      }
    }
    try {
      (sprite as { tint?: number }).tint = color;
      (sprite as { alpha?: number }).alpha = alpha;
      const source = (texture as { source?: { update?: () => void } }).source;
      source?.update?.();
    } catch {
      /* ignore — preview is best-effort */
    }
  }

  function clearSamPreview() {
    const app = appRef.current;
    const sprite = samMaskPreviewSpriteRef.current as
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
    samMaskPreviewSpriteRef.current = null;
    const tex = samMaskPreviewTextureRef.current as
      | { destroy?: () => void }
      | null;
    try {
      tex?.destroy?.();
    } catch {
      /* ignore */
    }
    samMaskPreviewTextureRef.current = null;
    samMaskPreviewCanvasRef.current = null;
  }

  /**
   * v3.6 — paint per-click point markers on the overlay layer. Reads
   * positives + negatives directly off the SamTool so the canvas never
   * has to mirror the tool's coordinate-rounding logic.
   *
   * Marker spec (CVAT-style):
   *   - radius ~6px in image-space (legible at typical zoom).
   *   - Positives: green fill with white outline.
   *   - Negatives: red fill with white outline.
   */
  async function drawSamPoints(): Promise<void> {
    const app = appRef.current;
    if (!app) return;
    let GraphicsCtor: typeof import("pixi.js").Graphics | undefined;
    try {
      const pixi = await import("pixi.js");
      GraphicsCtor = pixi.Graphics;
    } catch {
      return;
    }
    // Test environments may stub pixi.js without a Graphics export — bail
    // quietly so the live preview is a best-effort no-op rather than a
    // hard crash. Production builds always have Graphics available.
    if (!GraphicsCtor) return;
    let g = samPointsGfxRef.current as InstanceType<typeof GraphicsCtor> | null;
    if (!g) {
      try {
        g = new GraphicsCtor();
      } catch {
        return;
      }
      samPointsGfxRef.current = g;
      try {
        app.overlayLayer.addChild(g as never);
      } catch {
        /* ignore — overlay layer attach is best-effort */
      }
    }
    try {
      g.clear();
    } catch {
      return;
    }
    const positives = samTool.getPositives();
    const negatives = samTool.getNegatives();
    const radius = 6;
    const POSITIVE_GREEN = 0x22c55e;
    const NEGATIVE_RED = 0xef4444;
    const OUTLINE_WHITE = 0xffffff;
    try {
      for (const [x, y] of positives) {
        g.circle(x, y, radius);
        g.fill({ color: POSITIVE_GREEN, alpha: 1 });
        g.circle(x, y, radius);
        g.stroke({ color: OUTLINE_WHITE, width: 1.5, alpha: 1 });
      }
      for (const [x, y] of negatives) {
        g.circle(x, y, radius);
        g.fill({ color: NEGATIVE_RED, alpha: 1 });
        g.circle(x, y, radius);
        g.stroke({ color: OUTLINE_WHITE, width: 1.5, alpha: 1 });
      }
    } catch {
      /* ignore — primitive drawing is best-effort under jsdom mocks */
    }
  }

  function clearSamPoints() {
    const g = samPointsGfxRef.current as { clear?: () => void } | null;
    if (g && typeof g.clear === "function") g.clear();
  }

  /**
   * v3.6 — paint numbered markers for each SAM tracking object. Reads
   * the markers list from the SamTrack bridge slice (published by
   * <SamTrackPanel> after each successful addObjectAtFrame).
   *
   * Each marker is its own Pixi Container so we can tear them down
   * individually on reset. Style: filled circle with the obj_id rendered
   * inside in white. Color cycles through a small palette so adjacent
   * markers are easy to tell apart.
   */
  async function drawSamTrackMarkers(): Promise<void> {
    const app = appRef.current;
    if (!app) return;
    let pixi:
      | typeof import("pixi.js")
      | undefined;
    try {
      pixi = await import("pixi.js");
    } catch {
      return;
    }
    if (!pixi || !pixi.Graphics || !pixi.Container || !pixi.Text) return;
    const markers = useSamTrackBridge.getState().markers;
    // Tear down any existing markers — we re-render the full set on
    // every change rather than diffing. The list is small (<10 typical).
    for (const c of samTrackMarkersGfxRef.current) {
      try {
        (app.overlayLayer as { removeChild?: (c: never) => void }).removeChild?.(
          c as never,
        );
      } catch {
        /* ignore */
      }
    }
    samTrackMarkersGfxRef.current = [];
    const PALETTE = [
      0x3b82f6, // blue
      0xf59e0b, // amber
      0x10b981, // emerald
      0xec4899, // pink
      0x8b5cf6, // violet
      0xef4444, // red
    ];
    const radius = 10;
    for (const m of markers as SamTrackMarker[]) {
      const color = PALETTE[(m.objId - 1) % PALETTE.length];
      try {
        const container = new pixi.Container();
        const circle = new pixi.Graphics();
        circle.circle(m.x, m.y, radius);
        circle.fill({ color, alpha: 1 });
        circle.circle(m.x, m.y, radius);
        circle.stroke({ color: 0xffffff, width: 1.5, alpha: 1 });
        const label = new pixi.Text({
          text: String(m.objId),
          style: {
            fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif",
            fontSize: 11,
            fill: 0xffffff,
            fontWeight: "600",
          },
        });
        // Center the label over the circle.
        const lw = (label as { width: number }).width || 6;
        const lh = (label as { height: number }).height || 12;
        (label as { x: number }).x = m.x - lw / 2;
        (label as { y: number }).y = m.y - lh / 2;
        (container as unknown as { addChild: (c: never) => unknown }).addChild(
          circle as never,
        );
        (container as unknown as { addChild: (c: never) => unknown }).addChild(
          label as never,
        );
        (app.overlayLayer as unknown as { addChild: (c: never) => unknown }).addChild(
          container as never,
        );
        samTrackMarkersGfxRef.current.push(container);
      } catch {
        /* best-effort under jsdom mocks */
      }
    }
  }

  function clearSamTrackMarkers() {
    const app = appRef.current;
    if (!app) {
      samTrackMarkersGfxRef.current = [];
      return;
    }
    for (const c of samTrackMarkersGfxRef.current) {
      try {
        (app.overlayLayer as { removeChild?: (c: never) => void }).removeChild?.(
          c as never,
        );
      } catch {
        /* ignore */
      }
    }
    samTrackMarkersGfxRef.current = [];
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
    // Plan 09 Task 11 — initial hardness pull + live subscribe so the
    // toolbar slider stays in sync with the tool's per-dab rasteriser.
    mask.setHardness(useTool.getState().maskHardness);
    mask.setEraser(useTool.getState().maskEraser);
    const unsubMaskRadius = useTool.subscribe((s, prev) => {
      if (s.maskBrushRadius !== prev.maskBrushRadius) {
        mask.setRadius(s.maskBrushRadius);
      }
      if (s.maskHardness !== prev.maskHardness) {
        mask.setHardness(s.maskHardness);
      }
      if (s.maskEraser !== prev.maskEraser) {
        mask.setEraser(s.maskEraser);
      }
    });
    const tag = new TagTool(getClass, getFrame, idGen);

    if (tool === "sam") {
      // SAM activation calls /sam/encode. When the model service is offline
      // (audit bug 8a), the api now returns 503 model_service_unreachable.
      // Surface that to the user as a toast — without it the failed promise
      // would just become an unhandled rejection in the console.
      //
      // v3.5 Phase C — first-encode after a model load can block 5-30s.
      // Open a status-polling overlay if activate() hasn't resolved
      // within 2 seconds; the warm-session path (well under 2s) never
      // sees the overlay flash. The overlay polls /models/sam-status
      // and dismisses itself when state→ready/error.
      const overlayDelayMs = 2000;
      const overlayTimer = window.setTimeout(() => {
        setSamLoadOverlayOpen(true);
      }, overlayDelayMs);
      void samTool
        .activate()
        .catch((err: unknown) => {
          const message = describeSamError(err);
          showToast(message, { variant: "error", duration: 5000 });
        })
        .finally(() => {
          window.clearTimeout(overlayTimer);
          setSamLoadOverlayOpen(false);
        });
    } else {
      samTool.reset();
      setSamLoadOverlayOpen(false);
      // v3.6 — drop any leftover SAM preview when the user switches
      // away from the tool so a stale mask never lingers under bbox /
      // polygon / mask brush.
      clearSamPreview();
      clearSamPoints();
    }

    function pointerXY(e: PointerEvent): Point {
      const rect = host!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const s = scaleRef.current || 1;
      const off = offsetRef.current;
      return { x: (cx - off.x) / s, y: (cy - off.y) / s };
    }

    /**
     * Clamp a pointer to the live image bounds. Returns ``p`` unchanged
     * when the texture hasn't loaded (1×1 sentinel). Mirrors
     * ``clampToImage`` in BboxTool — kept local so the SAM box-mode
     * branch doesn't need to import the bbox helper.
     */
    function clampPointToImage(p: Point): Point {
      if (imageSize.w <= 1 || imageSize.h <= 1) return p;
      return {
        x: Math.max(0, Math.min(imageSize.w, p.x)),
        y: Math.max(0, Math.min(imageSize.h, p.y)),
      };
    }

    function hitTest(p: Point): string | null {
      const drafts = Object.values(useAnnotations.getState().byId).filter(
        (d) => d.frameId === frameId,
      );
      const hidden = useAnnotations.getState().hiddenAnnotationIds;
      const hClass = useAnnotations.getState().hiddenClassIds;
      // Plan 14 Phase 8 Task 6 — locked annotations are excluded from
      // the body hit-test so a normal click cannot select them. Right-
      // click still hits them (handled by the ContextMenu's separate
      // hitTestClient path).
      const locked = useAnnotations.getState().lockedIds;
      // Top-most (highest zOrder) wins.
      const sorted = drafts
        .filter(
          (d) =>
            !hidden.includes(d.tempId) &&
            !hClass.includes(d.classId) &&
            !locked.has(d.tempId),
        )
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
      // v3.8 Phase 3 — pointerdowns originating inside the floating
      // Text-mode panel must NOT be eaten by the canvas. Without this
      // guard, the SAM-tool branch below calls e.preventDefault() which
      // blocks the input from receiving focus, and every subsequent
      // keystroke goes to <body> instead -- triggering global shortcuts
      // (1-9 commit, Backspace pop, etc.) instead of typing into the
      // prompt box.
      const tgt = e.target as HTMLElement | null;
      if (tgt?.closest?.('[data-testid="sam-text-prompt-input"]')) {
        return;
      }
      // v3.2 Issue 2: pan branch — runs BEFORE tool routing so a
      // Space-armed click or middle-mouse click never gets eaten by the
      // active tool's onPointerDown (which would otherwise start a bbox
      // drag, drop a polygon vertex, etc.).
      const isMiddle = e.button === 1;
      if (spacePanRef.current || isMiddle) {
        // Suppress browser middle-click default (autoscroll on Windows /
        // open-link-in-new-tab over <a>). Space-pan also benefits from
        // preventDefault to avoid focus-shifts on click.
        e.preventDefault();
        try {
          host!.setPointerCapture(e.pointerId);
        } catch {
          /* setPointerCapture not always available in jsdom */
        }
        panActiveRef.current = true;
        panOriginRef.current = {
          clientX: e.clientX,
          clientY: e.clientY,
          startOffset: { x: offsetRef.current.x, y: offsetRef.current.y },
        };
        setDragCursor("grabbing");
        return;
      }
      const p = pointerXY(e);
      if (tool === "cursor") {
        // Plan 14 Phase 8 Task 6 — locked annotations are not draggable
        // or resizable. Skip the handle / body / vertex drag-init paths
        // when the currently selected target is locked; selection
        // hit-testing below uses the locked-aware ``hitTest()`` so a
        // normal click doesn't re-target a locked annotation either.
        const lockedIds = useAnnotations.getState().lockedIds;
        // 1. If we have a selected bbox, did we click one of its handles?
        const sel = getSelectedBbox();
        if (sel && !lockedIds.has(sel.id)) {
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
        if (polySel && !lockedIds.has(polySel.id)) {
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
          // Plan-09 Phase 5 Task 12 — alt-click on an edge inserts a new
          // vertex at the projected point and immediately starts dragging
          // it (so the user can reposition it without a second click).
          // Hover-only ghost marker is deferred to a later iteration.
          if (e.altKey) {
            const edge = hitTestEdge(polySel.poly, p);
            if (edge !== null) {
              const nextPoly = insertVertex(
                polySel.poly,
                edge.edgeIndex,
                edge.projected,
              );
              const newIndex = edge.edgeIndex + 1;
              useAnnotations
                .getState()
                .update(polySel.id, { geometry: nextPoly });
              dragRef.current = {
                mode: "vertex",
                id: polySel.id,
                index: newIndex,
                original: nextPoly,
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
        }

        // 2. No drag intent → fall through to selection (existing behaviour).
        const hit = hitTest(p);
        if (hit) {
          if (e.shiftKey) {
            useAnnotations.getState().toggleSelect(hit);
          } else {
            useAnnotations.getState().select(hit);
          }
          return;
        }
        // 3. Plan 14 Phase 8 Task 7 — empty-canvas LMB drag starts a
        // marquee selection. We DEFER ``clearSelection`` to pointerup
        // (sub-4px drag = click-to-clear); larger drags compute a hit
        // set against the marquee rect. Modifier rules: only Shift is
        // honoured (extends the existing selection) — Cmd / Ctrl / Alt
        // bail out to the legacy click path so other tools (Alt-edge
        // insert, etc.) keep working.
        if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          marqueeDraftRef.current = {
            anchor: p,
            current: p,
            shift: e.shiftKey,
            startClient: { x: e.clientX, y: e.clientY },
          };
          try {
            host!.setPointerCapture(e.pointerId);
          } catch {
            /* setPointerCapture not always available in jsdom */
          }
          return;
        }
        // Modifier-bearing empty-canvas click — preserve legacy behaviour.
        if (!e.shiftKey) {
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
        const mode = useTool.getState().samMode;
        if (mode === "track") {
          // v3.6 — canvas teach-back. v3.8 Phase 4-video step F7: a
          // drag now seeds a bbox prompt; a click (sub-threshold drag)
          // falls back to the legacy point prompt. We start a draft
          // here and resolve at pointer-up.
          const clamped = clampPointToImage(p);
          samTrackBoxDraftRef.current = { anchor: clamped, current: clamped };
          try {
            host!.setPointerCapture(e.pointerId);
          } catch {
            /* setPointerCapture not always available in jsdom */
          }
        } else if (mode === "box") {
          // v3.8 Phase 2 — once a box is committed, treat further
          // pointerdowns as point refinement (positive=left,
          // negative=right) anchored to that box. The user clears the
          // box via Esc to start a new selection.
          if (samTool.getBox()) {
            const promise = samTool.addClick(p, { pointer: e.button });
            void drawSamPoints();
            promise
              .then((result) => {
                if (result) {
                  const cls = useTool.getState().activeClassId;
                  const color = hexFromColor(cls ? classMap[cls] : undefined);
                  void drawSamMaskPreview(result.counts, result.size, color);
                }
              })
              .catch((err: unknown) => {
                showToast(describeSamError(err), {
                  variant: "error",
                  duration: 5000,
                });
              });
          } else {
            // No box yet — start a drag. Clamp to image bounds (mirrors
            // BboxTool) so a drag past the canvas backdrop produces a
            // sane xyxy on release.
            const clamped = clampPointToImage(p);
            samBoxDraftRef.current = { anchor: clamped, current: clamped };
            try {
              host!.setPointerCapture(e.pointerId);
            } catch {
              /* setPointerCapture not always available in jsdom */
            }
          }
        } else if (mode === "point") {
          // v3.6 — fire-and-await addClick. The SamTool mutates its
          // positive/negative arrays *synchronously* before awaiting
          // /sam/decode, so we kick off the network call, then paint
          // the click marker (now visible in the tool's arrays) so the
          // user gets immediate feedback. When decode resolves we
          // paint the mask overlay live (CVAT-style) — no Enter required.
          const promise = samTool.addClick(p, { pointer: e.button });
          // Eager marker paint — addClick has already pushed the point.
          void drawSamPoints();
          promise
            .then((result) => {
              if (result) {
                const cls = useTool.getState().activeClassId;
                const color = hexFromColor(cls ? classMap[cls] : undefined);
                void drawSamMaskPreview(result.counts, result.size, color);
              }
            })
            .catch((err: unknown) => {
              showToast(describeSamError(err), {
                variant: "error",
                duration: 5000,
              });
            });
        }
        // text mode is driven by the floating input — pointer events on
        // the canvas are no-ops so the user can still pan/zoom.
      }
    }

    /**
     * Plan-09b Task 2 — paint or clear the alt+hover edge-insert ghost.
     * The ghost graphics is lazily created on first paint and parked on
     * the overlay layer. ``hit`` is null when the cursor is not within
     * INSERT_TOLERANCE_PX of any polygon edge (or when alt is released);
     * we ``clear()`` in that case so the dot disappears without
     * destroying the node.
     */
    async function paintEdgeGhost(
      hit: { projected: { x: number; y: number } } | null,
      color: number,
    ): Promise<void> {
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
      let g = ghostEdgeGfxRef.current as
        | InstanceType<typeof Graphics>
        | null;
      if (!g) {
        g = new Graphics();
        ghostEdgeGfxRef.current = g;
        try {
          (app.overlayLayer as { addChild: (c: never) => unknown }).addChild(
            g as never,
          );
        } catch {
          /* ignore — overlay may be unavailable in test mocks */
        }
      }
      try {
        (g as { clear?: () => void }).clear?.();
      } catch {
        /* ignore */
      }
      if (!hit) return;
      try {
        const gg = g as {
          circle?: (x: number, y: number, r: number) => unknown;
          fill?: (opts: { color: number; alpha: number }) => unknown;
        };
        gg.circle?.(hit.projected.x, hit.projected.y, 4);
        gg.fill?.({ color, alpha: 0.5 });
      } catch {
        /* ignore — Graphics ops are best-effort under test mocks */
      }
    }

    function clearEdgeGhost(): void {
      const g = ghostEdgeGfxRef.current as
        | { clear?: () => void }
        | null;
      if (g) {
        try {
          g.clear?.();
        } catch {
          /* ignore */
        }
      }
    }

    function onMove(e: PointerEvent) {
      // v3.2 Issue 2: pan-move branch. While a pan drag is in flight,
      // delta is computed against the captured origin (not the previous
      // event) so accumulated rounding can't drift the offset.
      if (panActiveRef.current && panOriginRef.current) {
        const origin = panOriginRef.current;
        const dx = e.clientX - origin.clientX;
        const dy = e.clientY - origin.clientY;
        autoFitRef.current = false;
        const next = panBy(
          {
            scale: scaleRef.current,
            offset: { x: origin.startOffset.x, y: origin.startOffset.y },
          },
          dx,
          dy,
        );
        applyFrame(next);
        return;
      }
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
      } else if (tool === "sam" && samTrackBoxDraftRef.current) {
        // Track-mode bbox-seed in-flight drag — paint a live xyxy
        // preview. Sub-4px drags fall back to a click-prompt at up.
        const draft = samTrackBoxDraftRef.current;
        const clamped = clampPointToImage(p);
        draft.current = clamped;
        const x = Math.min(draft.anchor.x, clamped.x);
        const y = Math.min(draft.anchor.y, clamped.y);
        const w = Math.abs(draft.anchor.x - clamped.x);
        const h = Math.abs(draft.anchor.y - clamped.y);
        if (w >= 4 || h >= 4) void drawPreviewRect({ x, y, w, h });
      } else if (tool === "sam" && samBoxDraftRef.current) {
        // SAM box-mode in-flight drag — paint a live xyxy preview using
        // the existing bbox preview Graphics so the user sees what
        // they're about to send to /sam/box-prompt.
        const draft = samBoxDraftRef.current;
        const clamped = clampPointToImage(p);
        draft.current = clamped;
        const x = Math.min(draft.anchor.x, clamped.x);
        const y = Math.min(draft.anchor.y, clamped.y);
        const w = Math.abs(draft.anchor.x - clamped.x);
        const h = Math.abs(draft.anchor.y - clamped.y);
        void drawPreviewRect({ x, y, w, h });
      } else if (tool === "cursor") {
        // Plan 14 Phase 8 Task 7 — live marquee preview while dragging.
        const marquee = marqueeDraftRef.current;
        if (marquee) {
          marquee.current = p;
          const x = Math.min(marquee.anchor.x, p.x);
          const y = Math.min(marquee.anchor.y, p.y);
          const w = Math.abs(marquee.anchor.x - p.x);
          const h = Math.abs(marquee.anchor.y - p.y);
          void drawMarqueeRect({ x, y, w, h });
          return;
        }
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
            // Vertex hover takes priority over the edge-ghost — clear it
            // so we don't show a ghost dot stacked on a real handle.
            clearEdgeGhost();
            return;
          }
        }
        // Plan-09b Task 2 — alt+hover edge-insert ghost dot. Only when
        // cursor tool is active, alt is held, a polygon is selected, and
        // the cursor is within tolerance of an edge. Pure predicate plus
        // a hitTestEdge call; cleanup-on-clear via clear().
        const edgeHit = polySel ? hitTestEdge(polySel.poly, p) : null;
        if (
          shouldShowEdgeGhost({
            tool: "cursor",
            alt: e.altKey === true,
            polygonSelected: !!polySel,
            hit: edgeHit,
          })
        ) {
          const cls = polySel
            ? useAnnotations.getState().byId[polySel.id]?.classId
            : null;
          const color = hexFromColor(cls ? classMap[cls] : undefined);
          void paintEdgeGhost(edgeHit, color);
        } else {
          clearEdgeGhost();
        }
        if (dragCursor !== null) setDragCursor(null);
        const hit = hitTest(p);
        const cur = useTool.getState().hoveredAnnotationId;
        if (hit !== cur) useTool.getState().setHoveredAnnotationId(hit);
      }
    }

    function onUp(e: PointerEvent) {
      // v3.2 Issue 2: pan-release branch. Pan state is shared between
      // Space-drag and middle-mouse drag; on release we revert the
      // cursor, but if Space is still held we leave it on "grab" so
      // the next click can pan again without re-pressing Space.
      if (panActiveRef.current) {
        panActiveRef.current = false;
        panOriginRef.current = null;
        try {
          host!.releasePointerCapture(e.pointerId);
        } catch {
          /* not all environments implement releasePointerCapture */
        }
        if (spacePanRef.current) setDragCursor("grab");
        else setDragCursor(null);
        return;
      }
      const p = pointerXY(e);
      if (tool === "bbox") {
        bbox.onPointerUp(p);
        clearPreview();
      } else if (tool === "mask") {
        mask.onPointerUp(p);
      } else if (tool === "sam" && samTrackBoxDraftRef.current) {
        // Finalise the Track-mode drag — small drag = click prompt
        // (legacy behaviour); real drag = box prompt to the panel.
        const draft = samTrackBoxDraftRef.current;
        samTrackBoxDraftRef.current = null;
        try {
          host!.releasePointerCapture(e.pointerId);
        } catch {
          /* not all environments implement releasePointerCapture */
        }
        const clamped = clampPointToImage(p);
        const x1 = Math.min(draft.anchor.x, clamped.x);
        const y1 = Math.min(draft.anchor.y, clamped.y);
        const x2 = Math.max(draft.anchor.x, clamped.x);
        const y2 = Math.max(draft.anchor.y, clamped.y);
        const dx = x2 - x1;
        const dy = y2 - y1;
        clearPreview();
        if (dx < 4 || dy < 4) {
          // Click-prompt fallback — route to the panel's click handler.
          const handler = useSamTrackBridge.getState().onCanvasClick;
          if (handler) {
            try {
              handler([clamped.x, clamped.y]);
            } catch {
              /* handler errors surface as toasts in the panel */
            }
            void drawSamTrackMarkers();
          } else {
            showToast("Open the Track panel first.", { variant: "warning" });
          }
        } else {
          const boxHandler = useSamTrackBridge.getState().onCanvasBox;
          if (boxHandler) {
            try {
              boxHandler([x1, y1, x2, y2]);
            } catch {
              /* handler errors surface as toasts in the panel */
            }
            void drawSamTrackMarkers();
          } else {
            showToast("Open the Track panel first.", { variant: "warning" });
          }
        }
      } else if (tool === "sam" && samBoxDraftRef.current) {
        // Finalise the SAM box drag — drop minimum-size drags as noise
        // (mirrors BboxTool's MIN_DRAG_PX gate) and forward to the
        // SAM tool. Errors propagate as toasts via describeSamError.
        const draft = samBoxDraftRef.current;
        samBoxDraftRef.current = null;
        try {
          host!.releasePointerCapture(e.pointerId);
        } catch {
          /* not all environments implement releasePointerCapture */
        }
        const clamped = clampPointToImage(p);
        const x1 = Math.min(draft.anchor.x, clamped.x);
        const y1 = Math.min(draft.anchor.y, clamped.y);
        const x2 = Math.max(draft.anchor.x, clamped.x);
        const y2 = Math.max(draft.anchor.y, clamped.y);
        const dx = x2 - x1;
        const dy = y2 - y1;
        // 4px min edge — same threshold the bbox tool uses to filter
        // accidental click-as-drag events.
        if (dx < 4 || dy < 4) {
          // Drag was below the noise threshold — drop the rubber-band
          // overlay and skip setBox.
          clearPreview();
        } else {
          // v3.8 Phase 2 — keep the rubber-band rectangle painted as a
          // persistent SAM-box outline so the user sees what they are
          // refining when they click inside it. Cleared by Esc / commit
          // through clearPreview().
          void drawPreviewRect({ x: x1, y: y1, w: dx, h: dy });
          samTool
            .setBox([x1, y1, x2, y2])
            .then((result) => {
              if (result) {
                const cls = useTool.getState().activeClassId;
                const color = hexFromColor(cls ? classMap[cls] : undefined);
                void drawSamMaskPreview(result.counts, result.size, color);
              }
            })
            .catch((err: unknown) => {
              showToast(describeSamError(err), {
                variant: "error",
                duration: 5000,
              });
            });
        }
      } else if (tool === "cursor") {
        // Plan 14 Phase 8 Task 7 — finalise marquee selection.
        const marquee = marqueeDraftRef.current;
        if (marquee) {
          marqueeDraftRef.current = null;
          try {
            host!.releasePointerCapture(e.pointerId);
          } catch {
            /* not all environments implement releasePointerCapture */
          }
          clearMarquee();
          const dxClient = e.clientX - marquee.startClient.x;
          const dyClient = e.clientY - marquee.startClient.y;
          const dragDist = Math.sqrt(dxClient * dxClient + dyClient * dyClient);
          if (dragDist < 4) {
            // Click, not a drag — preserve existing "click empty canvas
            // to deselect" behaviour. Shift-click on empty canvas is a
            // no-op (matches the legacy branch above).
            if (!marquee.shift) {
              useAnnotations.getState().clearSelection();
            }
            return;
          }
          // Real drag — hit-test all annotations on the current frame.
          const state = useAnnotations.getState();
          const matched = marqueeHitTest({
            byId: state.byId,
            frameId,
            hidden: state.hiddenAnnotationIds,
            hiddenClasses: state.hiddenClassIds,
            locked: state.lockedIds,
            rect: {
              x1: marquee.anchor.x,
              y1: marquee.anchor.y,
              x2: marquee.current.x,
              y2: marquee.current.y,
            },
          });
          if (marquee.shift) {
            const union = Array.from(
              new Set([...state.selectedIds, ...matched]),
            );
            state.selectMany(union);
          } else {
            state.selectMany(matched);
          }
          return;
        }
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

      // Plan 14 Phase 8 Task 4 — universal class-palette triggers.
      // ``/`` opens the palette in set-active mode (replaces the
      // earlier SAM-only ``/`` binding); ``R`` opens it in reassign
      // mode when at least one annotation is selected; Cmd-Shift-C is
      // a power-user alt for set-active.
      //
      // These guard against modifier collisions so ⌘A still selects
      // all and ⌘P still prints (etc.). We intentionally fire BEFORE
      // the tool-specific switch so the palette is reachable from any
      // tool.
      if (
        e.key === "/" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setPaletteMode("set-active");
        setPaletteInitialQuery("");
        setPaletteOpen(true);
        return;
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "c"
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setPaletteMode("set-active");
        setPaletteInitialQuery("");
        setPaletteOpen(true);
        return;
      }
      if (
        e.key.toLowerCase() === "r" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        const selIds = useAnnotations.getState().selectedIds;
        if (selIds.length > 0) {
          e.preventDefault();
          e.stopImmediatePropagation();
          setPaletteMode("reassign");
          setPaletteInitialQuery("");
          setPaletteOpen(true);
          return;
        }
      }

      // Plan 14 Phase 8 Task 6 — L toggles lock on selected annotations.
      if (
        e.key.toLowerCase() === "l" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        const selIds = useAnnotations.getState().selectedIds;
        if (selIds.length > 0) {
          e.preventDefault();
          e.stopImmediatePropagation();
          for (const id of selIds) {
            useAnnotations.getState().toggleLock(id);
          }
          return;
        }
      }

      // Plan 14 Phase 8 Task 6 — Cmd/Ctrl-D duplicates the selected
      // annotations 16px right + 16px down.
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "d"
      ) {
        const selIds = useAnnotations.getState().selectedIds;
        if (selIds.length > 0) {
          e.preventDefault();
          e.stopImmediatePropagation();
          const bounds =
            imageSize.w > 1 && imageSize.h > 1 ? imageSize : undefined;
          for (const id of selIds) {
            useAnnotations.getState().duplicate(id, 16, 16, bounds);
          }
          return;
        }
      }

      // Plan 14 Phase 8 Task 5 — type-to-filter quick reassign. When
      // ≥1 annotation is selected and the user types a single letter
      // (a-z) outside any input, open the palette in reassign mode
      // with the letter pre-filled. Numbers 1..9 keep their existing
      // ``set active class N`` behavior; modifier keys (⌘/Ctrl/Alt/Meta)
      // are ignored so ⌘A still selects all.
      if (
        e.key.length === 1 &&
        /^[a-z]$/i.test(e.key) &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        const selIds = useAnnotations.getState().selectedIds;
        if (selIds.length > 0) {
          e.preventDefault();
          e.stopImmediatePropagation();
          setPaletteMode("reassign");
          setPaletteInitialQuery(e.key.toLowerCase());
          setPaletteOpen(true);
          return;
        }
      }

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
        if (e.key === "Enter") {
          // v3.6 — commit() resets the SamTool's internal state; clear
          // the live preview + markers so they don't linger over the
          // newly-committed annotation that the normal render path is
          // about to paint.
          // v3.8 Phase 2 — also clear the persistent box outline.
          const ok = samTool.commit();
          if (ok) {
            clearSamPreview();
            clearSamPoints();
            clearPreview();
          }
        } else if (e.key === "Escape") {
          samTool.reset();
          clearSamPreview();
          clearSamPoints();
          clearPreview();
        } else if (e.key === "Backspace" || e.key === "Delete") {
          // v3.8 Phase 1 — pop the most recently added click, re-decode
          // and repaint. Suppresses any parent handler while a SAM
          // candidate is active.
          e.preventDefault();
          e.stopPropagation();
          samTool
            .popLastClick()
            .then((result) => {
              void drawSamPoints();
              if (result === null) {
                clearSamPreview();
              } else {
                const cls = useTool.getState().activeClassId;
                const color = hexFromColor(cls ? classMap[cls] : undefined);
                void drawSamMaskPreview(result.counts, result.size, color);
              }
            })
            .catch((err: unknown) => {
              showToast(describeSamError(err), { variant: "error", duration: 5000 });
            });
        } else if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
          // v3.8 Phase 1 — commit with the class whose idx matches the
          // pressed digit. Power-user path: click on the object, press
          // the digit. No-op when no class with that idx exists.
          const idx = parseInt(e.key, 10) - 1;
          const target = (classesProp ?? []).find((c) => c.idx === idx);
          if (target) {
            e.preventDefault();
            e.stopPropagation();
            const ok = samTool.commit(target.id);
            if (ok) {
              clearSamPreview();
              clearSamPoints();
              clearPreview();
              // Make the chosen class active so the next candidate
              // inherits it without an extra UI click.
              useTool.getState().setActiveClassId(target.id);
            }
          }
        }
      }
    }

    // Plan-09b Task 2 — clear the edge-insert ghost when alt is released
    // (no pointermove fires on key change alone) and when the pointer
    // leaves the canvas host.
    function onAltKeyUp(e: KeyboardEvent): void {
      if (e.key === "Alt" || e.altKey === false) clearEdgeGhost();
    }
    function onPointerLeaveHost(): void {
      clearEdgeGhost();
    }
    // Plan-09b Task 2 — selection change away from a polygon clears
    // the ghost; without this it would linger until the next move.
    const unsubSel = useAnnotations.subscribe((s, prev) => {
      if (s.selectedIds !== prev.selectedIds) {
        const stillPoly = s.selectedIds.some((id) => {
          const d = s.byId[id];
          return d && d.geometry.kind === "polygon";
        });
        if (!stillPoly) clearEdgeGhost();
      }
    });

    host.addEventListener("pointerdown", onDown);
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerup", onUp);
    host.addEventListener("pointerleave", onPointerLeaveHost);
    host.addEventListener("contextmenu", onContextMenu);
    // Capture-phase keydown so the bbox nudge runs BEFORE the page-level
    // ArrowLeft/Right asset-navigation handler — the canvas calls
    // stopPropagation() when it nudges, preventing accidental nav.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onAltKeyUp);
    return () => {
      host.removeEventListener("pointerdown", onDown);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerup", onUp);
      host.removeEventListener("pointerleave", onPointerLeaveHost);
      host.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onAltKeyUp);
      clearEdgeGhost();
      unsubSel();
      // Reset any in-flight polygon when the tool changes / the asset
      // unmounts so the preview doesn't linger.
      polygon.cancel();
      clearPolygonPreview();
      // Likewise for in-flight mask brush strokes.
      mask.cancel();
      clearMaskPreview();
      // v3.6 — drop SAM live preview overlays on tool/asset change.
      clearSamPreview();
      clearSamPoints();
      unsubMaskRadius();
    };
  }, [tool, activeClassId, frameId, imageSize, samTool, classMap, classesProp]);

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

  function applySamText(): void {
    const text = samTextDraft.trim();
    if (text.length === 0 || samTextPending) return;
    const cls = useTool.getState().activeClassId;
    setSamTextPending(true);

    // v3.8 Phase 3.7 — Find-all path: skip the preview dance, fetch
    // every candidate above the score threshold, and commit each as
    // its own annotation under the active class. The user gets all
    // instances on screen at once instead of "best match" + Enter.
    if (samTextFindAll) {
      if (!cls) {
        showToast("Pick an active class first.", {
          variant: "warning",
          duration: 4000,
        });
        setSamTextPending(false);
        return;
      }
      // v3.8 Phase 3 followup — interactive default is more permissive
      // (0.25) than the Auto-annotate dialog's batch default (0.4) so
      // the user's first "type a thing, see it" experience isn't an
      // empty toast. The dialog gives an explicit slider for the
      // higher-precision batch path.
      samTool
        .applyTextMulti(text, 0.25, cls)
        .then(({ created, total }) => {
          if (created > 0) {
            showToast(
              `Created ${created} annotation${created === 1 ? "" : "s"} for "${text}".`,
              { variant: "success", duration: 3000 },
            );
            // Drop any leftover preview from a prior single-mode run
            // so the new annotations stand on their own.
            clearSamPreview();
            clearSamPoints();
          } else if (total > 0) {
            showToast(
              `${total} candidate${total === 1 ? "" : "s"} below score threshold.`,
              { variant: "warning", duration: 3000 },
            );
          } else {
            showToast(`No matches for "${text}".`, {
              variant: "warning",
              duration: 3000,
            });
          }
        })
        .catch((err: unknown) => {
          showToast(describeSamError(err), {
            variant: "error",
            duration: 5000,
          });
        })
        .finally(() => {
          setSamTextPending(false);
        });
      return;
    }

    // Best-match path (v3.6 behavior) — paint the text-prompt mask
    // preview live so the user sees the segmented region without
    // pressing Enter.
    samTool
      .setText(text)
      .then((result) => {
        if (result) {
          const color = hexFromColor(cls ? classMap[cls] : undefined);
          void drawSamMaskPreview(result.counts, result.size, color);
        }
      })
      .catch((err: unknown) => {
        showToast(describeSamError(err), {
          variant: "error",
          duration: 5000,
        });
      })
      .finally(() => {
        setSamTextPending(false);
      });
  }

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
        toImageXY={toImageXY}
        frameId={frameId}
        imageBounds={
          imageSize.w > 1 && imageSize.h > 1 ? imageSize : undefined
        }
      />
      {/* v3.8 Phase 3.6 — Class Command Palette. Plan 14 Phase 8 Task 4
          productized this: ``/`` and ``Cmd-Shift-C`` open it in
          set-active mode; ``R`` (and Task 5's type-to-filter flow)
          opens it in reassign mode. The palette itself wires the
          set-active / update calls — the canvas only owns the open
          state and the source classes. */}
      <ClassCommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        mode={paletteMode}
        projectId={classesProp?.[0]?.project_id ?? ""}
        classes={classesProp ?? []}
        selectedAnnotationIds={
          paletteMode === "reassign"
            ? useAnnotations.getState().selectedIds
            : undefined
        }
        initialQuery={paletteInitialQuery}
      />
      <ModelLoadingOverlay
        open={samLoadOverlayOpen}
        onClose={() => setSamLoadOverlayOpen(false)}
        onError={(detail) => {
          if (detail && detail !== "model_load_failed") {
            showToast(`SAM load failed: ${detail}`, { variant: "error" });
          }
        }}
      />
      {tool === "sam" && samMode === "text" && (
        // v3.5 Phase D — floating text-prompt input. Top-left of the
        // canvas so it never collides with the toolbar's mode picker.
        // Apply runs samTool.setText; the resulting mask lives on the
        // SamTool's lastResult so the existing Enter→commit flow still
        // applies.
        <div
          data-testid="sam-text-prompt-input"
          style={{
            position: "absolute",
            top: 12,
            left: 12,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 8px",
            borderRadius: 8,
            background: "var(--glass-bg-strong, rgba(20,20,22,0.85))",
            backdropFilter: "blur(12px)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
            zIndex: 50,
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {/* v3.8 Phase 3 followup — pre-flight class check. The input
              and Apply button are disabled until the user picks an
              active class from the right panel. Clear inline hint
              instead of an after-the-fact toast on Apply. */}
          {!activeClassId && (
            <span
              data-testid="sam-text-no-class-hint"
              style={{
                fontSize: 11,
                color: "var(--warning, oklch(0.78 0.18 85))",
                whiteSpace: "nowrap",
              }}
            >
              Select a class first →
            </span>
          )}
          <input
            type="text"
            placeholder={
              activeClassId ? "enter object name…" : "(class required)"
            }
            value={samTextDraft}
            onChange={(e) => setSamTextDraft(e.target.value)}
            disabled={!activeClassId || samTextPending}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applySamText();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setSamTextDraft("");
              }
            }}
            data-testid="sam-text-prompt-field"
            autoFocus
            style={{
              minWidth: 220,
              height: 28,
              padding: "0 8px",
              borderRadius: 6,
              border: "1px solid var(--border-subtle, rgba(255,255,255,0.1))",
              background: "var(--bg-subtle, rgba(255,255,255,0.05))",
              color: "var(--text-primary, #fff)",
              fontSize: 12.5,
              outline: "none",
            }}
          />
          <button
            type="button"
            data-testid="sam-text-prompt-apply"
            disabled={
              !activeClassId ||
              samTextPending ||
              samTextDraft.trim().length === 0
            }
            onClick={() => applySamText()}
            style={(() => {
              const inert =
                !activeClassId ||
                samTextDraft.trim().length === 0 ||
                samTextPending;
              return {
                height: 28,
                padding: "0 12px",
                borderRadius: 6,
                border: "none",
                background: inert
                  ? "var(--bg-subtle, rgba(255,255,255,0.05))"
                  : "var(--accent, #6366f1)",
                color: inert
                  ? "var(--text-tertiary, rgba(255,255,255,0.4))"
                  : "var(--accent-fg, #fff)",
                fontSize: 12,
                fontWeight: 500,
                cursor: inert ? "not-allowed" : "pointer",
              };
            })()}
          >
            {samTextPending ? "…" : "Apply"}
          </button>
          {/* v3.8 Phase 3.7 — Find all toggle. When on, Apply commits
              every candidate above 0.4 score directly to the active
              class instead of showing one preview and waiting for
              Enter. Default on so multi-instance images work as users
              expect ("type 'person', get all 3"). */}
          <label
            data-testid="sam-text-find-all"
            title="Find every instance above the score threshold"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontSize: 11,
              color: "var(--text-secondary, rgba(255,255,255,0.7))",
              cursor: "pointer",
              userSelect: "none",
              whiteSpace: "nowrap",
              borderLeft: "1px solid var(--border-subtle, rgba(255,255,255,0.1))",
              paddingLeft: 6,
              marginLeft: 2,
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={samTextFindAll}
              onChange={(e) => setSamTextFindAll(e.target.checked)}
              style={{ margin: 0 }}
            />
            All instances
          </label>
          {/* v3.8 Phase 3 — Use class prompt / Save to class helpers.
              Owned by a sub-component so the useQueryClient/useMutation
              hooks only run when Text mode is actually open. Tests that
              mount AnnotationCanvas without a QueryClientProvider stay
              green because they never enter Text mode. */}
          <TextSamHelpers
            classes={classesProp}
            activeClassId={activeClassId}
            samTextDraft={samTextDraft}
            onUsePrompt={setSamTextDraft}
          />
        </div>
      )}
      {/* Plan 14 Phase 8 Task 7 — multi-select status chip. */}
      <MultiSelectStatusChip />
    </div>
  );
}

/**
 * Plan 14 Phase 8 Task 7 — small floating chip that surfaces multi-
 * select shortcuts (R / Backspace / Esc) at the bottom-center of the
 * canvas viewport. Only renders when ``selectedIds.length > 1``.
 */
function MultiSelectStatusChip(): ReactElement | null {
  const count = useAnnotations((s) => s.selectedIds.length);
  if (count <= 1) return null;
  return (
    <div
      data-testid="multi-select-status-chip"
      aria-live="polite"
      style={{
        position: "absolute",
        bottom: 12,
        left: "50%",
        transform: "translateX(-50%)",
        padding: "5px 12px",
        borderRadius: 999,
        fontSize: 11.5,
        fontWeight: 500,
        whiteSpace: "nowrap",
        background: "var(--glass-bg-strong, rgba(20,20,22,0.85))",
        backdropFilter: "blur(12px)",
        boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
        color: "var(--text-primary, #fff)",
        pointerEvents: "none",
        zIndex: 30,
      }}
    >
      {`${count} selected · R to reassign · Backspace to delete · Esc to clear`}
    </div>
  );
}

// v3.8 Phase 3 — Helper buttons next to the Text-mode prompt input.
// Lives outside the parent so its useQueryClient/useMutation only
// instantiate when the Text panel is actually rendered (i.e. when the
// production app is running, where the React Query provider always
// exists). Test mounts of <AnnotationCanvas /> without a provider
// stay green because they never enter Text mode.
function TextSamHelpers({
  classes,
  activeClassId,
  samTextDraft,
  onUsePrompt,
}: {
  classes: ClassRow[] | undefined;
  activeClassId: string | null;
  samTextDraft: string;
  onUsePrompt: (prompt: string) => void;
}) {
  const qc = useQueryClient();
  const updateClassPrompt = useMutation({
    mutationFn: ({
      projectId,
      classId,
      prompt,
    }: {
      projectId: string;
      classId: string;
      prompt: string | null;
    }) => classesApi.update(projectId, classId, { text_prompt: prompt }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["classes", vars.projectId] });
      showToast("Prompt saved to class.", { variant: "success", duration: 2200 });
    },
    onError: () =>
      showToast("Failed to save prompt to class.", { variant: "error" }),
  });

  const cls = (classes ?? []).find((c) => c.id === activeClassId);
  if (!cls) return null;
  const stored = (cls.text_prompt ?? "").trim();
  const draft = samTextDraft.trim();
  const showUse = stored.length > 0 && stored !== draft;
  const showSave =
    draft.length > 0 && draft !== stored && !updateClassPrompt.isPending;
  if (!showUse && !showSave) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        borderLeft: "1px solid var(--border-subtle, rgba(255,255,255,0.1))",
        paddingLeft: 6,
        marginLeft: 2,
      }}
    >
      {showUse && (
        <button
          type="button"
          data-testid="sam-text-use-class-prompt"
          title={`Use ${cls.name}'s prompt: "${stored}"`}
          onClick={() => onUsePrompt(stored)}
          style={{
            height: 24,
            padding: "0 8px",
            borderRadius: 5,
            border: "1px solid var(--border-subtle, rgba(255,255,255,0.1))",
            background: "transparent",
            color: "var(--text-secondary, rgba(255,255,255,0.7))",
            fontSize: 11,
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          Use {cls.name}'s prompt
        </button>
      )}
      {showSave && (
        <button
          type="button"
          data-testid="sam-text-save-to-class"
          title={`Save current input as ${cls.name}'s prompt`}
          onClick={() =>
            updateClassPrompt.mutate({
              projectId: cls.project_id,
              classId: cls.id,
              prompt: draft,
            })
          }
          style={{
            height: 24,
            padding: "0 8px",
            borderRadius: 5,
            border: "1px solid var(--accent, #6366f1)",
            background: "transparent",
            color: "var(--accent, #6366f1)",
            fontSize: 11,
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          Save to {cls.name}
        </button>
      )}
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
  labelMap: Map<
    string,
    { container: unknown; text: unknown; bg: unknown; check?: unknown }
  >,
  id: string,
  bbox: { x: number; y: number; w: number; h: number },
  labelText: string,
  color: number,
  TextCtor: typeof import("pixi.js").Text,
  ContainerCtor: typeof import("pixi.js").Container,
  GraphicsCtor: typeof import("pixi.js").Graphics,
  fontSize = 11,
  position: "auto" | "above" | "below" | "left" | "right" = "auto",
  status: "proposed" | "accepted" | "rejected" = "proposed",
): void {
  let entry = labelMap.get(id);
  if (!entry) {
    const container = new ContainerCtor();
    const bg = new GraphicsCtor();
    const text = new TextCtor({
      text: labelText,
      style: {
        fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif",
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
  // Plan-09b Task 3 — accepted-status checkmark badge. A small green
  // ✓ glyph drawn just to the right of the label bg with a hand-rolled
  // two-segment polyline (no icon library on the canvas). The check
  // graphics is a child of the label container so it auto-translates
  // with the label and is destroyed when the label container is.
  if (status === "accepted") {
    let check = entry.check as
      | InstanceType<typeof GraphicsCtor>
      | undefined;
    if (!check) {
      check = new GraphicsCtor();
      (entry.container as unknown as AddChildSink).addChild(check as never);
      entry.check = check;
    }
    const cg = check as {
      clear: () => void;
      moveTo: (x: number, y: number) => void;
      lineTo: (x: number, y: number) => void;
      stroke: (opts: { color: number; width: number; alpha?: number }) => void;
      visible?: boolean;
    };
    cg.clear();
    // ~12px glyph. Two segments: short down-right then long up-right.
    const cx0 = tw + 4; // 4px gap to the right of the bg
    const cy0 = (th - 12) / 2; // vertically centered
    cg.moveTo(cx0 + 1, cy0 + 6);
    cg.lineTo(cx0 + 5, cy0 + 10);
    cg.lineTo(cx0 + 11, cy0 + 2);
    cg.stroke({ color: 0x22c55e, width: 2, alpha: 1 });
    if (typeof cg.visible === "boolean") cg.visible = true;
  } else if (entry.check) {
    // Status changed away from accepted — hide the badge but keep the
    // node parked on the container for cheap toggling.
    const cg = entry.check as { clear?: () => void; visible?: boolean };
    try {
      cg.clear?.();
    } catch {
      /* ignore */
    }
    if (typeof cg.visible === "boolean") cg.visible = false;
  }
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
 * Plan-09b Task 1 — paint a translucent class-coloured sprite for a
 * prev-revision mask_rle overlay. The sprite is parked in
 * ``compareMap`` under ``id`` so the existing reconcile cleanup loop
 * removes it from the layer when the id leaves pinned ∪ hovered.
 *
 * 30% alpha keeps the prev mask visually subordinate to the live shape
 * underneath, mirroring the dashed-outline cue used for bbox/polygon
 * compare overlays.
 */
async function paintCompareMaskSprite(
  layer: { addChild: (c: never) => unknown; removeChild?: (c: never) => void },
  compareMap: Map<string, unknown>,
  id: string,
  counts: string,
  size: [number, number],
  color: number,
): Promise<void> {
  let pixi: typeof import("pixi.js") | undefined;
  try {
    pixi = await import("pixi.js");
  } catch {
    return;
  }
  if (!pixi) return;
  // Re-check; the id may have left pinned ∪ hovered while we were
  // awaiting the dynamic import.
  if (compareMap.has(id)) return;
  const [h, w] = size;
  if (h <= 0 || w <= 0) return;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  try {
    const { decodeRLE } = await import("@/canvas/maskio");
    const mask = decodeRLE(counts, h, w);
    const img = ctx.createImageData(w, h);
    const data = img.data;
    // Pre-multiplied class colour at full alpha for ON pixels; the
    // sprite-level alpha (0.3 below) does the translucent blending.
    const r = (color >> 16) & 0xff;
    const g = (color >> 8) & 0xff;
    const b = color & 0xff;
    for (let row = 0; row < h; row += 1) {
      for (let col = 0; col < w; col += 1) {
        const i = (row * w + col) * 4;
        if (mask[row * w + col]) {
          data[i] = r;
          data[i + 1] = g;
          data[i + 2] = b;
          data[i + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  } catch {
    return;
  }
  // The id may have been dropped while the decode was in flight.
  if (compareMap.has(id)) return;
  let texture: InstanceType<typeof pixi.Texture>;
  try {
    texture = pixi.Texture.from(cv as TexImageSource);
  } catch {
    return;
  }
  const sprite = new pixi.Sprite(texture);
  try {
    (sprite as { alpha?: number }).alpha = 0.3;
  } catch {
    /* alpha is best-effort */
  }
  layer.addChild(sprite as never);
  compareMap.set(id, sprite);
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
/**
 * Plan-09 Phase 5 Task 4 — dashed-segment helpers for the prev-revision
 * compare overlay. Pixi 8's Graphics has no native dashed stroke; we
 * walk the geometry and emit alternating drawn/skipped segments.
 *
 * Both helpers stroke at 50% alpha so the overlay reads as "ghost"
 * relative to the live shape rendered underneath.
 */
const COMPARE_DASH_PX = 6;
const COMPARE_GAP_PX = 4;
const COMPARE_ALPHA = 0.5;

function drawDashedSegment(
  g: { moveTo: (x: number, y: number) => void; lineTo: (x: number, y: number) => void },
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len === 0) return;
  const ux = dx / len;
  const uy = dy / len;
  const period = COMPARE_DASH_PX + COMPARE_GAP_PX;
  let dist = 0;
  while (dist < len) {
    const dashStart = dist;
    const dashEnd = Math.min(dist + COMPARE_DASH_PX, len);
    g.moveTo(x1 + ux * dashStart, y1 + uy * dashStart);
    g.lineTo(x1 + ux * dashEnd, y1 + uy * dashEnd);
    dist += period;
  }
}

function drawDashedRect(
  g: {
    moveTo: (x: number, y: number) => void;
    lineTo: (x: number, y: number) => void;
    stroke: (s: { color: number; width: number; alpha: number }) => void;
  },
  x: number,
  y: number,
  w: number,
  h: number,
  color: number,
): void {
  drawDashedSegment(g, x, y, x + w, y);
  drawDashedSegment(g, x + w, y, x + w, y + h);
  drawDashedSegment(g, x + w, y + h, x, y + h);
  drawDashedSegment(g, x, y + h, x, y);
  g.stroke({ color, width: 2, alpha: COMPARE_ALPHA });
}

function drawDashedPolygon(
  g: {
    moveTo: (x: number, y: number) => void;
    lineTo: (x: number, y: number) => void;
    stroke: (s: { color: number; width: number; alpha: number }) => void;
  },
  points: ReadonlyArray<readonly [number, number]>,
  color: number,
): void {
  if (points.length < 2) return;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    drawDashedSegment(g, a[0], a[1], b[0], b[1]);
  }
  g.stroke({ color, width: 2, alpha: COMPARE_ALPHA });
}

/**
 * Plan 14 Phase 8 Task 7 — pure marquee hit-test. Returns the ids of
 * annotations on ``frameId`` whose axis-aligned bounding box overlaps
 * the marquee rect (any-overlap, not strict containment). Hidden
 * annotations / hidden classes / locked annotations are filtered out
 * (they can never be selected by a marquee). Exported so the unit
 * tests can verify the math without driving Pixi pointer events.
 */
export function marqueeHitTest(args: {
  byId: Record<string, import("@/state/annotations").AnnotationDraft>;
  frameId: string | null;
  hidden: ReadonlyArray<string>;
  hiddenClasses: ReadonlyArray<string>;
  locked: ReadonlySet<string>;
  rect: { x1: number; y1: number; x2: number; y2: number };
}): string[] {
  const x1 = Math.min(args.rect.x1, args.rect.x2);
  const y1 = Math.min(args.rect.y1, args.rect.y2);
  const x2 = Math.max(args.rect.x1, args.rect.x2);
  const y2 = Math.max(args.rect.y1, args.rect.y2);
  const matched: string[] = [];
  for (const d of Object.values(args.byId)) {
    if (d.frameId !== args.frameId) continue;
    if (args.hidden.includes(d.tempId)) continue;
    if (args.hiddenClasses.includes(d.classId)) continue;
    if (args.locked.has(d.tempId)) continue;
    const bb = annotationBoundingBox(d.geometry);
    if (!bb) continue;
    const overlaps =
      bb.x <= x2 && bb.x + bb.w >= x1 && bb.y <= y2 && bb.y + bb.h >= y1;
    if (overlaps) matched.push(d.tempId);
  }
  return matched;
}

/**
 * Plan 14 Phase 8 Task 7 — return an axis-aligned bounding rect for an
 * annotation's geometry. Used by the cursor-tool marquee to test which
 * annotations overlap the drag rectangle. Returns ``null`` for tag /
 * mask geometries (mask bbox would require RLE decoding which is too
 * heavy for a hover-rate hit-test; tags have no spatial position).
 */
export function annotationBoundingBox(
  g: import("@/state/annotations").Geometry,
): { x: number; y: number; w: number; h: number } | null {
  if (g.kind === "bbox") {
    return { x: g.x, y: g.y, w: g.w, h: g.h };
  }
  if (g.kind === "polygon") {
    if (g.points.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [px, py] of g.points) {
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  return null;
}

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
export function describeSamError(err: unknown): string {
  // Axios error shape: ``err.response.data.{error,detail}``.
  const errObj = err as {
    response?: {
      status?: number;
      data?: { error?: string; detail?: string };
    };
    message?: string;
  };
  const status = errObj?.response?.status;
  const data = errObj?.response?.data;
  const errorCode = data?.error;
  const detail = typeof data?.detail === "string" ? data.detail : undefined;
  if (status === 503 || errorCode === "model_service_unreachable") {
    return "SAM unavailable — model service is not running.";
  }
  // v3.8 Phase 3 — Text mode requires SAM 3 specifically. Surface the
  // actionable hint instead of a generic "SAM unavailable" toast so
  // the user knows where to switch.
  if (status === 409 && errorCode === "sam3_not_enabled") {
    return "Text mode needs SAM 3. Switch the active model in Settings → Models.";
  }
  // v3.8 Phase 4-video step F7 — bubble the server's detail string when
  // present. The api/model service emit "tracker_init_failed: ...",
  // "add_object_failed: ...", etc. — those are far more actionable than
  // a generic "SAM unavailable" fallback.
  if (detail) return detail;
  if (errorCode) return errorCode;
  if (typeof errObj?.message === "string" && errObj.message) {
    return errObj.message;
  }
  return "SAM unavailable — please try again later.";
}
