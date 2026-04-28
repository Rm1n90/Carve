import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Editor right-panel resize hook (v2.7).
 *
 * Encapsulates the pointer-drag plumbing for the divider between the canvas
 * and the classes/objects panel. Returns the current width plus a ref
 * callback that the consumer sets on the divider element. The hook
 * registers a native ``pointerdown`` listener on that element via
 * ``addEventListener``; this both sidesteps React 19's synthetic-event
 * boundary (where ``clientX`` does not always survive) and gives us a
 * stable, low-level event we can verify against in jsdom.
 *
 * Behaviour:
 *  - Min width is enforced at ``MIN_WIDTH_PX``.
 *  - Max width is the smaller of ``MAX_WIDTH_PX`` and 50% of the viewport,
 *    so on narrow displays the panel never eats more than half the screen.
 *  - The chosen width is persisted to localStorage under
 *    ``STORAGE_KEY`` so it survives reload.
 *  - During drag we add ``cursor: col-resize`` and ``user-select: none`` to
 *    the document body to keep the cursor consistent and avoid accidental
 *    text selection if the pointer leaves the handle mid-drag.
 *
 * pointermove fires at ~60Hz which is cheap enough to handle directly
 * without rAF batching.
 */

export const STORAGE_KEY = "carve.editor.rightPanelWidth.v1";
export const MIN_WIDTH_PX = 240;
export const MAX_WIDTH_PX = 600;
export const DEFAULT_WIDTH_PX = 320;

export function clampPanelWidth(raw: number, viewportWidth: number): number {
  const halfViewport = Math.floor(viewportWidth / 2);
  const max = Math.min(MAX_WIDTH_PX, halfViewport > 0 ? halfViewport : MAX_WIDTH_PX);
  if (raw < MIN_WIDTH_PX) return MIN_WIDTH_PX;
  if (raw > max) return max;
  return Math.round(raw);
}

function readPersistedWidth(viewportWidth: number): number {
  if (typeof window === "undefined") return DEFAULT_WIDTH_PX;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_WIDTH_PX;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return DEFAULT_WIDTH_PX;
    return clampPanelWidth(parsed, viewportWidth);
  } catch {
    // localStorage can throw in private browsing or sandboxed iframes.
    return DEFAULT_WIDTH_PX;
  }
}

interface UseResizableRightPanelResult {
  width: number;
  isDragging: boolean;
  /** Ref callback to attach to the resize handle element. */
  handleRef: (el: HTMLElement | null) => void;
}

export function useResizableRightPanel(): UseResizableRightPanelResult {
  const [width, setWidth] = useState<number>(() => {
    const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
    return readPersistedWidth(vw);
  });
  const [isDragging, setIsDragging] = useState(false);

  // Stash the latest width in a ref so we can persist on pointerup without
  // chasing it through React state. Updated synchronously by setWidth.
  const widthRef = useRef(width);
  widthRef.current = width;

  const elRef = useRef<HTMLElement | null>(null);

  // Re-clamp the persisted width on viewport resize. Without this the user
  // can shrink the window past 2× the panel width and the panel ends up
  // covering more than the canvas. Pure post-render clamp; no jank.
  useEffect(() => {
    function onResize() {
      setWidth((prev) => clampPanelWidth(prev, window.innerWidth));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Attach a native pointerdown listener whenever the consumer wires the
  // handle ref. We re-run this when ``elRef.current`` changes via a tiny
  // mount counter; React's ref callback semantics give us the new node
  // before useEffect runs.
  const [refTick, setRefTick] = useState(0);
  const handleRef = useCallback((el: HTMLElement | null) => {
    elRef.current = el;
    // Force the listener-bind effect to re-run when the host element
    // identity changes (mount/unmount/remount). Using a tick state keeps
    // the listener attachment idempotent across React strict-mode double
    // invokes and through hot reload.
    setRefTick((n) => n + 1);
  }, []);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    function onPointerDown(e: PointerEvent | MouseEvent) {
      // Only react to the primary mouse button; stylus/touch share the
      // same code path and report ``button: 0`` as well.
      if (e.button !== 0) return;
      e.preventDefault();
      setIsDragging(true);

      const startX = e.clientX;
      const startWidth = widthRef.current;

      function onMove(ev: PointerEvent | MouseEvent) {
        // The right edge of the panel is anchored to the viewport's right
        // side. Dragging the handle LEFT (negative dx) widens the panel;
        // dragging RIGHT narrows it.
        const dx = ev.clientX - startX;
        const next = clampPanelWidth(startWidth - dx, window.innerWidth);
        setWidth(next);
      }
      function onUp() {
        setIsDragging(false);
        window.removeEventListener("pointermove", onMove as EventListener);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        try {
          window.localStorage.setItem(STORAGE_KEY, String(widthRef.current));
        } catch {
          // Persistence is best-effort.
        }
      }
      window.addEventListener("pointermove", onMove as EventListener);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    el.addEventListener("pointerdown", onPointerDown as EventListener);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown as EventListener);
    };
  }, [refTick]);

  return { width, isDragging, handleRef };
}
