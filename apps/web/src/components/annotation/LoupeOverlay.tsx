// Armin Mehri — mehri.armin@gmail.com
/**
 * LoupeOverlay — CVAT / Ultralytics-style magnifier.
 *
 * Hold ``Z`` (physical key, layout-independent via ``e.code``) → a
 * 220 px circular zoomed view of the underlying image follows the
 * pointer. Release → disappears. The loupe reuses the same image URL
 * the Pixi sprite is rendering, so there's no additional fetch — the
 * browser cache serves the second copy instantly.
 *
 * Implementation: CSS ``background-image`` + ``background-position``
 * + ``background-size``. Zero Pixi RenderTexture machinery means the
 * loupe ships independently of the canvas internals and adds no
 * per-frame render cost. Trade-off: the loupe shows pixels only —
 * not in-progress annotation strokes. v2 can swap to a Pixi sub-
 * renderer when there's a real need to see annotations in the loupe.
 *
 * Spec ``docs/superpowers/specs/2026-05-16-annotator-accelerators-design.md`` F7.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { cn } from "@/lib/cn";

interface Props {
  /** Host element of the canvas — pointer coordinates resolve against this rect. */
  hostRef: RefObject<HTMLDivElement | null>;
  /** Source image URL — same as the one fed to the Pixi sprite. */
  imageUrl: string;
  /** Natural image dimensions. ``null`` while the asset is loading. */
  imageSize: { w: number; h: number } | null;
  /** Map host-relative client px → image-space px. */
  toImageXY: (clientX: number, clientY: number) => { x: number; y: number };
}

const LOUPE_SIZE_PX = 220;
const LOUPE_ZOOM = 3;
const LOUPE_OFFSET_PX = 18;

/**
 * Decide which corner of the cursor the loupe lives in so it never
 * overlaps the host edge. ``baseX``/``baseY`` are the natural
 * down-right offset; we flip per-axis when the loupe would clip.
 */
function placeLoupe(
  cursorClient: { x: number; y: number },
  hostRect: DOMRect,
  size: number,
): { left: number; top: number } {
  const wantRight = cursorClient.x + LOUPE_OFFSET_PX;
  const wantBottom = cursorClient.y + LOUPE_OFFSET_PX;
  const fitsRight = wantRight + size <= hostRect.right;
  const fitsBottom = wantBottom + size <= hostRect.bottom;
  const left = fitsRight
    ? wantRight - hostRect.left
    : cursorClient.x - LOUPE_OFFSET_PX - size - hostRect.left;
  const top = fitsBottom
    ? wantBottom - hostRect.top
    : cursorClient.y - LOUPE_OFFSET_PX - size - hostRect.top;
  return { left, top };
}

export function LoupeOverlay({
  hostRef,
  imageUrl,
  imageSize,
  toImageXY,
}: Props) {
  const [enabled, setEnabled] = useState(false);
  const [pos, setPos] = useState<{
    clientX: number;
    clientY: number;
    imageX: number;
    imageY: number;
  } | null>(null);
  const enabledRef = useRef(false);
  enabledRef.current = enabled;

  useEffect(() => {
    function isEditable(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null;
      if (!el || typeof el !== "object") return false;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true;
      if (el.isContentEditable) return true;
      return false;
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.code !== "KeyZ") return;
      if (e.repeat) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (isEditable(e.target)) return;
      setEnabled(true);
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code !== "KeyZ") return;
      setEnabled(false);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !enabled) {
      setPos(null);
      return;
    }
    function move(e: PointerEvent) {
      const { x, y } = toImageXY(e.clientX, e.clientY);
      setPos({ clientX: e.clientX, clientY: e.clientY, imageX: x, imageY: y });
    }
    function leave() {
      setPos(null);
    }
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerleave", leave);
    return () => {
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
    };
  }, [hostRef, toImageXY, enabled]);

  if (!enabled || !pos || !imageSize || !imageUrl) return null;
  if (
    pos.imageX < 0 ||
    pos.imageY < 0 ||
    pos.imageX > imageSize.w ||
    pos.imageY > imageSize.h
  ) {
    return null;
  }
  const host = hostRef.current;
  if (!host) return null;

  const rect = host.getBoundingClientRect();
  const { left, top } = placeLoupe(
    { x: pos.clientX, y: pos.clientY },
    rect,
    LOUPE_SIZE_PX,
  );
  const zoomedW = imageSize.w * LOUPE_ZOOM;
  const zoomedH = imageSize.h * LOUPE_ZOOM;
  const bgX = -(pos.imageX * LOUPE_ZOOM - LOUPE_SIZE_PX / 2);
  const bgY = -(pos.imageY * LOUPE_ZOOM - LOUPE_SIZE_PX / 2);

  return (
    <div
      data-testid="loupe-overlay"
      aria-hidden
      className={cn(
        "pointer-events-none absolute z-20 rounded-full",
        "border-2 border-white/80",
        "shadow-[0_4px_12px_rgba(0,0,0,0.4)]",
        "select-none overflow-hidden",
      )}
      style={{
        left: `${left}px`,
        top: `${top}px`,
        width: `${LOUPE_SIZE_PX}px`,
        height: `${LOUPE_SIZE_PX}px`,
        backgroundImage: `url("${imageUrl}")`,
        backgroundSize: `${zoomedW}px ${zoomedH}px`,
        backgroundPosition: `${bgX}px ${bgY}px`,
        backgroundRepeat: "no-repeat",
      }}
    >
      <span
        aria-hidden
        className="absolute inset-0 flex items-center justify-center"
      >
        <span className="block w-px h-3 bg-white/70" />
        <span className="block h-px w-3 bg-white/70 absolute" />
      </span>
    </div>
  );
}
