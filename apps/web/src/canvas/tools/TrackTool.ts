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
    /** v3.27 — maps a SAM 3.1 frame_idx to the DB Frame row's id so masks
     *  arriving from add_prompt / propagate can be auto-committed as
     *  annotation drafts. Returning ``null`` means "frame_id unknown" —
     *  the mask is still kept in bridge.masksByFrame but no annotation
     *  is upserted (the draft would be unanchored). */
    private getFrameId: (frameIdx: number) => string | null = () => null,
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

    // v3.27 fix — native SAM 3.1 multiplex requires obj_id to be EXPLICIT
    // for point/box prompts (only text auto-allocates per detection).
    // Omitting obj_id raised:
    //   AssertionError: When points are provided, obj_id must be provided.
    // Allocate the next free id client-side BEFORE the request so the
    // response masks land in the right bridge slot.
    let targetObjId: number;
    if (isRefine) {
      targetObjId = hitId!;
    } else {
      const classId = this.getActiveClassId();
      if (classId === null) throw new Error("track_tool_no_active_class");
      targetObjId = nextFreeObjId();
      useTrackBridge.getState().registerObject({
        objId: targetObjId,
        classId,
        seedFrame: args.frameIdx,
        seedKind: "click",
      });
    }

    const body: PromptIn = {
      frame_idx: args.frameIdx,
      obj_id: targetObjId,
      points: [[args.x, args.y]],
      labels: [label],
    };

    const resp = await trackApi.prompt(
      this.assetId, sid, body, this.makePromptSignal(),
    );
    this.applyMasks(resp);
    void this.firePreview(args.frameIdx);
  }

  async dragBox(args: BoxArgs): Promise<void> {
    await this.ensureSession();
    const sid = useTrackBridge.getState().sessionId!;
    const classId = this.getActiveClassId();
    if (classId === null) throw new Error("track_tool_no_active_class");

    // Boxes always seed a new object (don't refine). Allocate id +
    // register BEFORE the request so the mask lands in the right slot.
    const targetObjId = nextFreeObjId();
    useTrackBridge.getState().registerObject({
      objId: targetObjId,
      classId,
      seedFrame: args.frameIdx,
      seedKind: "box",
    });

    const resp = await trackApi.prompt(this.assetId, sid, {
      frame_idx: args.frameIdx,
      obj_id: targetObjId,
      box: args.box,
    }, this.makePromptSignal());
    this.applyMasks(resp);
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
    const bridge = useTrackBridge.getState();
    bridge.mergeMasks(resp.frame_idx, resp.masks);

    // v3.27 — auto-commit each obj_id's mask as an annotation draft so
    // the canvas renders the segmentation immediately after a click /
    // box / text prompt. The deterministic tempId
    // ``track:{trackId}:{frameId}`` makes re-running the same prompt
    // idempotent (overwrites the prior draft for the same obj_id+frame).
    const frameId = this.getFrameId(resp.frame_idx);
    if (!frameId) return;
    const annotations = useAnnotations.getState();
    for (const [k, mask] of Object.entries(resp.masks)) {
      const objId = Number(k);
      if (!Number.isFinite(objId)) continue;
      const obj = bridge.objects.get(objId);
      const trackId = bridge.trackIds.get(objId);
      if (!obj || !trackId) continue;
      if (!mask.polygon || mask.polygon.length < 3) continue;
      const tempId = `track:${trackId}:${frameId}`;
      const existing = annotations.byId[tempId];
      if (existing) {
        // Refining an existing obj_id's mask — patch geometry.
        annotations.update?.(tempId, {
          geometry: { kind: "polygon", points: mask.polygon },
          dirty: true,
        });
      } else {
        annotations.add?.({
          tempId,
          classId: obj.classId,
          kind: "polygon",
          geometry: { kind: "polygon", points: mask.polygon },
          frameId,
          serverId: null,
          dirty: true,
          trackId,
        });
      }
    }
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

function nextFreeObjId(): number {
  // Native SAM 3.1 multiplex caps obj_id at 256 (server-side). Pick the
  // smallest positive integer not yet registered in the bridge so removed
  // ids can be reused, and refines never collide with seeds.
  const known = useTrackBridge.getState().objects;
  for (let i = 1; i <= 256; i++) {
    if (!known.has(i)) return i;
  }
  throw new Error("track_tool_obj_id_exhausted");
}
