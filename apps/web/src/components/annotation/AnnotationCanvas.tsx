import { useEffect, useRef, useState } from "react";

import { CanvasApp } from "@/canvas/App";
import { BboxTool, type Point } from "@/canvas/tools/BboxTool";
import { PolygonTool } from "@/canvas/tools/PolygonTool";
import { MaskBrushTool } from "@/canvas/tools/MaskBrushTool";
import { TagTool } from "@/canvas/tools/TagTool";
import { useTool, type ToolName } from "@/state/tool";

interface Props {
  width: number;
  height: number;
  imageUrl: string;
  frameId: string | null;
}

/**
 * Mounts a Pixi canvas, loads the image, and routes pointer/keyboard events
 * to the active tool. Re-renders when tool, dimensions, or image change.
 */
export function AnnotationCanvas({ width, height, imageUrl, frameId }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<CanvasApp | null>(null);
  const tool = useTool((s) => s.active);
  const activeClassId = useTool((s) => s.activeClassId);

  const [imageSize, setImageSize] = useState<{ w: number; h: number }>({ w: width, h: height });

  useEffect(() => {
    if (!hostRef.current) return;
    let cancelled = false;
    const app = new CanvasApp({ width, height, backgroundAlpha: 0 });
    appRef.current = app;
    (async () => {
      // Pixi.js Application init is async
      await app.init({ width, height, backgroundAlpha: 0 });
      if (cancelled) {
        app.destroy();
        return;
      }
      hostRef.current!.appendChild(app.app.canvas);
      // Load image into imageLayer
      try {
        const { Assets, Sprite } = await import("pixi.js");
        const tex = await Assets.load(imageUrl);
        const sprite = new Sprite(tex);
        app.imageLayer.addChild(sprite);
        const realW = sprite.width || width;
        const realH = sprite.height || height;
        setImageSize({ w: realW, h: realH });
      } catch {
        // Image load can fail in headless environments; canvas remains empty.
      }
    })();
    return () => {
      cancelled = true;
      try { app.destroy(); } catch { /* ignore cleanup errors */ }
      appRef.current = null;
    };
  }, [imageUrl, width, height]);

  // Tool routing — closures captured per render for current tool + class + frame
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

    function pointerXY(e: PointerEvent): Point {
      const rect = host!.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function onDown(e: PointerEvent) {
      const p = pointerXY(e);
      if (tool === "bbox") bbox.onPointerDown(p);
      else if (tool === "polygon") polygon.onPointerDown(p);
      else if (tool === "mask") mask.onPointerDown(p);
    }

    function onMove(e: PointerEvent) {
      const p = pointerXY(e);
      if (tool === "bbox") bbox.onPointerMove(p);
      else if (tool === "mask") mask.onPointerMove(p);
    }

    function onUp(e: PointerEvent) {
      const p = pointerXY(e);
      if (tool === "bbox") bbox.onPointerUp(p);
      else if (tool === "mask") mask.onPointerUp(p);
    }

    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (tool === "polygon") polygon.onKeyDown(e.key);
      else if (tool === "mask") mask.onKeyDown(e.key);
      else if (tool === "tag" && e.key.toLowerCase() === "t") tag.apply();
    }

    host.addEventListener("pointerdown", onDown);
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      host.removeEventListener("pointerdown", onDown);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [tool, activeClassId, frameId, imageSize]);

  return (
    <div
      ref={hostRef}
      role="region"
      aria-label={`Annotation canvas (${tool})`}
      style={{
        width,
        height,
        background: "#0a0a14",
        cursor: toolCursor(tool),
        position: "relative",
        overflow: "hidden",
      }}
    />
  );
}

function toolCursor(t: ToolName): string {
  switch (t) {
    case "bbox":
    case "polygon":
    case "mask":
      return "crosshair";
    default:
      return "default";
  }
}
