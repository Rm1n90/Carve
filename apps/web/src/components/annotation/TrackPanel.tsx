// Armin Mehri — mehri.armin@gmail.com
import { useEffect, useMemo, useRef, useState } from "react";
import { Eraser, Loader2, Play, Trash2, X } from "lucide-react";

import type { ClassRow } from "@/api/classes";
import { TrackTool } from "@/canvas/tools/TrackTool";
import { useTool } from "@/state/tool";
import { useTrackBridge } from "@/state/trackBridge";
import { useSamTrackBridge } from "@/state/samTrackBridge";
import { useAnnotations } from "@/state/annotations";
import { showToast } from "@/lib/toast";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/cn";

interface TrackPanelProps {
  assetId: string;
  currentFrameIdx: number;
  totalFrames: number;
  classes: ClassRow[];
  frameIdxToFrameId: Record<number, string>;
}

export function TrackPanel({
  assetId, currentFrameIdx, totalFrames, classes, frameIdxToFrameId,
}: TrackPanelProps) {
  const activeClassId = useTool((s) => s.activeClassId);
  const setActiveClassId = useTool((s) => s.setActiveClassId);
  const status = useTrackBridge((s) => s.status);
  const objects = useTrackBridge((s) => s.objects);
  const framesPropagated = useTrackBridge((s) => s.framesPropagated);

  const [textValue, setTextValue] = useState("");
  const [running, setRunning] = useState(false);

  // Live ref to the latest frame-idx → frame-id map so the tool's mask
  // commits always look up against the current map (the prop reference
  // changes when the frames query refetches).
  const frameMapRef = useRef(frameIdxToFrameId);
  frameMapRef.current = frameIdxToFrameId;
  const currentFrameIdxRef = useRef(currentFrameIdx);
  currentFrameIdxRef.current = currentFrameIdx;

  const toolRef = useRef<TrackTool | null>(null);
  if (toolRef.current === null) {
    toolRef.current = new TrackTool(
      assetId,
      () => useTool.getState().activeClassId,
      (frameIdx) => frameMapRef.current[frameIdx] ?? null,
    );
  }

  useEffect(() => {
    return () => {
      void toolRef.current?.closeSession();
    };
  }, []);

  // v3.27 — register the canvas → TrackTool dispatch via samTrackBridge.
  // AnnotationCanvas reads onCanvasClick / onCanvasBox from this bridge in
  // pointerup. The handlers translate pixel coords + altKey into TrackTool
  // method calls. The "alt" arg comes from the canvas pointerup event.
  useEffect(() => {
    const bridge = useSamTrackBridge.getState();
    bridge.setHandler((point, negative) => {
      const tool = toolRef.current;
      if (!tool) return;
      void tool.clickAt({
        frameIdx: currentFrameIdxRef.current,
        x: point[0],
        y: point[1],
        negative: negative ?? false,
      }).catch((err) => {
        showToast(`Track click failed: ${(err as Error).message}`, {
          variant: "error",
        });
      });
    });
    bridge.setBoxHandler((box) => {
      const tool = toolRef.current;
      if (!tool) return;
      void tool.dragBox({
        frameIdx: currentFrameIdxRef.current,
        box,
      }).catch((err) => {
        showToast(`Track box failed: ${(err as Error).message}`, {
          variant: "error",
        });
      });
    });
    return () => {
      useSamTrackBridge.getState().clear();
    };
  }, []);

  const objectList = useMemo(
    () => Array.from(objects.values()).sort((a, b) => a.objId - b.objId),
    [objects],
  );

  async function onTextSubmit() {
    const text = textValue.trim();
    if (!text) return;
    if (!activeClassId && classes.length > 0) setActiveClassId(classes[0].id);
    try {
      await toolRef.current!.addText({ frameIdx: currentFrameIdx, text });
      setTextValue("");
    } catch (err) {
      showToast(`Track text failed: ${(err as Error).message}`, {
        variant: "error",
      });
    }
  }

  async function onRunFull() {
    setRunning(true);
    try {
      await toolRef.current!.runFullTrack();
      showToast(
        `Tracked ${useTrackBridge.getState().framesPropagated} frames.`,
        { variant: "success" },
      );
    } catch (err) {
      showToast(`Tracking failed: ${(err as Error).message}`, {
        variant: "error",
      });
    } finally {
      setRunning(false);
    }
  }

  async function onDiscard() {
    try {
      await toolRef.current!.discard();
    } catch (err) {
      showToast(`Discard failed: ${(err as Error).message}`, {
        variant: "error",
      });
    }
  }

  const progressPct =
    totalFrames > 0
      ? Math.min(100, Math.round((framesPropagated / totalFrames) * 100))
      : 0;

  return (
    <aside
      role="complementary"
      aria-label="SAM 3.1 video tracking"
      data-testid="track-panel"
      className={cn(
        "flex flex-col gap-3 p-3 border-t border-[var(--glass-border)]",
        "glass-surface text-[12.5px]",
      )}
    >
      <header className="flex items-center justify-between">
        <span className="font-medium">Track</span>
        <span className="font-mono tabular-nums text-[10.5px] text-[color:var(--text-tertiary)]">
          Frame {currentFrameIdx + 1} / {totalFrames}
        </span>
      </header>

      {objectList.length === 0 && (
        <p className="text-[11px] text-[color:var(--text-secondary)]">
          Left-click on canvas to seed. Click an existing mask to refine.
          Right-click for negative.
        </p>
      )}

      {objectList.length > 0 && (
        <ul data-testid="track-object-list" className="grid gap-1">
          {objectList.map((o) => {
            const cls = classes.find((c) => c.id === o.classId);
            const currentFrameId = frameIdxToFrameId[currentFrameIdx];
            const tempIdOnFrame = currentFrameId
              ? `track:${useTrackBridge.getState().trackIds.get(o.objId)}:${currentFrameId}`
              : null;
            const hasMaskOnCurrentFrame = tempIdOnFrame
              ? !!useAnnotations.getState().byId[tempIdOnFrame]
              : false;
            return (
              <li
                key={o.objId}
                data-testid={`track-object-${o.objId}`}
                className="flex items-center gap-1.5 text-[11.5px]"
              >
                <span className="font-mono text-[10.5px] text-[color:var(--text-tertiary)] w-5">
                  #{o.objId}
                </span>
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: cls?.color ?? "#888" }}
                />
                <span className="flex-1 truncate">{cls?.name ?? o.classId}</span>
                <span className="text-[10px] text-[color:var(--text-tertiary)]">
                  ▸ frame {o.seedFrame}
                </span>
                {/* v3.27.5 — per-frame remove. Drops the polygon for
                    this obj on the CURRENT frame only; the obj stays
                    registered so propagation / refinement on other
                    frames is preserved. The X button below still
                    removes the obj across the whole video. */}
                <button
                  type="button"
                  data-testid={`track-remove-on-frame-${o.objId}`}
                  disabled={!hasMaskOnCurrentFrame}
                  onClick={() => {
                    if (!tempIdOnFrame) return;
                    useAnnotations.getState().remove(tempIdOnFrame);
                  }}
                  className="ml-1 inline-flex items-center justify-center h-5 w-5 rounded hover:bg-[var(--bg-hover)] disabled:opacity-30 disabled:cursor-not-allowed"
                  aria-label={`Remove object ${o.objId} on frame ${currentFrameIdx + 1}`}
                  title={`Remove from frame ${currentFrameIdx + 1}`}
                >
                  <Eraser className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  data-testid={`track-remove-${o.objId}`}
                  onClick={() => void toolRef.current!.removeObject(o.objId)}
                  className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-[var(--bg-hover)]"
                  aria-label={`Remove object ${o.objId} entirely`}
                  title="Remove from all frames"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex items-center gap-1.5">
        <Input
          type="text"
          data-testid="track-text-input"
          placeholder='Type a concept (e.g. "person")…'
          value={textValue}
          onChange={(e) => setTextValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void onTextSubmit();
            }
          }}
        />
        <button
          type="button"
          data-testid="track-text-submit"
          disabled={textValue.trim().length === 0}
          onClick={() => void onTextSubmit()}
          className="h-7 px-2 rounded bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] text-[11px] disabled:opacity-50"
        >
          Add
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="track-run"
          disabled={objects.size === 0 || running}
          onClick={() => void onRunFull()}
          className={cn(
            "inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-full",
            "bg-[var(--accent)] text-[color:var(--accent-fg)] font-medium",
            "disabled:bg-[var(--bg-subtle)] disabled:text-[color:var(--text-tertiary)] disabled:cursor-not-allowed",
          )}
        >
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          Run full track
        </button>
        <button
          type="button"
          data-testid="track-discard"
          disabled={objects.size === 0 && status === "idle"}
          onClick={() => void onDiscard()}
          className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-full bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] text-[11.5px] disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" /> Discard
        </button>
      </div>

      {(status === "running" || framesPropagated > 0) && (
        <div className="grid gap-1">
          <div className="h-2 rounded-full bg-[var(--bg-sunken)] overflow-hidden">
            <div
              className="h-full bg-[var(--accent)] transition-[width] duration-200"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <p className="text-[11px] text-[color:var(--text-tertiary)] tabular-nums">
            Tracked {framesPropagated} / {totalFrames} ({progressPct}%)
          </p>
        </div>
      )}
    </aside>
  );
}
