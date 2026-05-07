// Armin Mehri — mehri.armin@gmail.com
import { trackApi, type FrameMasks, type PromptIn } from "@/api/track";
import { useTrackBridge } from "@/state/trackBridge";
import { useAnnotations } from "@/state/annotations";

export interface ClickArgs {
  frameIdx: number;
  x: number;
  y: number;
  alt: boolean;
}

export interface BoxArgs {
  frameIdx: number;
  box: [number, number, number, number];
}

export interface TextArgs {
  frameIdx: number;
  text: string;
}

const PREVIEW_WINDOW = 5;

export class TrackTool {
  private previewAbort: AbortController | null = null;

  constructor(
    private assetId: string,
    private getActiveClassId: () => string | null,
  ) {}

  isActive(): boolean {
    return useTrackBridge.getState().sessionId !== null;
  }

  async openSession(): Promise<void> {
    if (this.isActive()) return;
    const r = await trackApi.open(this.assetId);
    useTrackBridge.getState().setSession(r.session_id, r.frame_count);
  }

  async closeSession(): Promise<void> {
    const sid = useTrackBridge.getState().sessionId;
    if (!sid) return;
    try {
      await trackApi.close(this.assetId, sid);
    } finally {
      this.previewAbort?.abort();
      useTrackBridge.getState().reset();
    }
  }

  async clickAt(args: ClickArgs): Promise<void> {
    await this.ensureSession();
    const sid = useTrackBridge.getState().sessionId!;
    const hitId = useTrackBridge.getState().hitTest(args.frameIdx, args.x, args.y);
    const isRefine = hitId !== null;
    const label = args.alt ? 0 : 1;

    const body: PromptIn = {
      frame_idx: args.frameIdx,
      points: [[args.x, args.y]],
      labels: [label],
    };
    if (isRefine) body.obj_id = hitId!;

    const resp = await trackApi.prompt(
      this.assetId, sid, body, this.makePromptSignal(),
    );
    this.applyMasks(resp);

    if (!isRefine) {
      const classId = this.getActiveClassId();
      if (classId === null) {
        throw new Error("track_tool_no_active_class");
      }
      const newId = inferNewObjId(resp);
      if (newId !== null) {
        useTrackBridge.getState().registerObject({
          objId: newId, classId, seedFrame: args.frameIdx, seedKind: "click",
        });
      }
    }

    void this.firePreview(args.frameIdx);
  }

  async dragBox(args: BoxArgs): Promise<void> {
    await this.ensureSession();
    const sid = useTrackBridge.getState().sessionId!;
    const classId = this.getActiveClassId();
    if (classId === null) throw new Error("track_tool_no_active_class");
    const resp = await trackApi.prompt(this.assetId, sid, {
      frame_idx: args.frameIdx, box: args.box,
    }, this.makePromptSignal());
    this.applyMasks(resp);
    const newId = inferNewObjId(resp);
    if (newId !== null) {
      useTrackBridge.getState().registerObject({
        objId: newId, classId, seedFrame: args.frameIdx, seedKind: "box",
      });
    }
    void this.firePreview(args.frameIdx);
  }

  async addText(args: TextArgs): Promise<void> {
    await this.ensureSession();
    const sid = useTrackBridge.getState().sessionId!;
    const classId = this.getActiveClassId();
    if (classId === null) throw new Error("track_tool_no_active_class");
    const resp = await trackApi.prompt(this.assetId, sid, {
      frame_idx: args.frameIdx, text: args.text,
    }, this.makePromptSignal());
    this.applyMasks(resp);
    for (const k of Object.keys(resp.masks)) {
      const objId = Number(k);
      if (Number.isFinite(objId)) {
        useTrackBridge.getState().registerObject({
          objId, classId, seedFrame: args.frameIdx, seedKind: "text",
        });
      }
    }
    void this.firePreview(args.frameIdx);
  }

  async removeObject(objId: number): Promise<void> {
    const sid = useTrackBridge.getState().sessionId;
    if (!sid) return;
    await trackApi.removeObject(this.assetId, sid, objId);
    useTrackBridge.getState().removeObject(objId);
  }

  async runFullTrack(): Promise<void> {
    const sid = useTrackBridge.getState().sessionId;
    if (!sid) throw new Error("track_tool_no_session");
    useTrackBridge.getState().setStatus("running");
    let cursor = 0;
    while (true) {
      const r = await trackApi.propagate(
        this.assetId, sid, { start_frame: cursor },
      );
      if (r.frames.length === 0) break;
      for (const f of r.frames) {
        this.applyMasks(f);
        cursor = f.frame_idx + 1;
      }
      useTrackBridge.getState().setFramesPropagated(cursor);
    }
    useTrackBridge.getState().setStatus("done");
  }

  async discard(): Promise<void> {
    const trackIds = useTrackBridge.getState().collectTrackIds();
    if (trackIds.length > 0) {
      try {
        await trackApi.bulkDeleteByTrackIds(this.assetId, trackIds);
        const removeMany = (
          useAnnotations.getState() as { removeManyByTrackIds?: (ids: string[]) => void }
        ).removeManyByTrackIds;
        removeMany?.(trackIds);
      } catch {
        // best-effort
      }
    }
    await this.closeSession();
  }

  private async ensureSession(): Promise<void> {
    if (!this.isActive()) await this.openSession();
  }

  private applyMasks(resp: FrameMasks): void {
    useTrackBridge.getState().mergeMasks(resp.frame_idx, resp.masks);
  }

  private makePromptSignal(): AbortSignal {
    this.previewAbort?.abort();
    const ac = new AbortController();
    this.previewAbort = ac;
    return ac.signal;
  }

  private async firePreview(frameIdx: number): Promise<void> {
    const sid = useTrackBridge.getState().sessionId;
    const total = useTrackBridge.getState().totalFrames;
    if (!sid) return;
    useTrackBridge.getState().setStatus("previewing");
    try {
      const r = await trackApi.propagate(this.assetId, sid, {
        start_frame: Math.max(0, frameIdx - PREVIEW_WINDOW),
        end_frame: Math.min(total - 1, frameIdx + PREVIEW_WINDOW),
      }, this.makePromptSignal());
      for (const f of r.frames) this.applyMasks(f);
    } catch {
      // aborted by next click — fine
    } finally {
      if (useTrackBridge.getState().status === "previewing") {
        useTrackBridge.getState().setStatus("seeding");
      }
    }
  }
}

function inferNewObjId(resp: FrameMasks): number | null {
  const ids = Object.keys(resp.masks).map(Number).filter(Number.isFinite);
  if (ids.length === 0) return null;
  const known = useTrackBridge.getState().objects;
  for (const id of ids) {
    if (!known.has(id)) return id;
  }
  return null;
}
