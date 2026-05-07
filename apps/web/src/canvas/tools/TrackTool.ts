// Armin Mehri — mehri.armin@gmail.com
import { trackApi, type FrameMasks, type PromptIn } from "@/api/track";
import { useTrackBridge } from "@/state/trackBridge";
import { useAnnotations } from "@/state/annotations";
import { useSamTrackBridge } from "@/state/samTrackBridge";

export interface ClickArgs {
  frameIdx: number;
  x: number;
  y: number;
  /** True for a NEGATIVE refinement click (right-click on canvas).
   *  Mapped to label=0 in the SAM 3.1 prompt body. Left-click → false
   *  → label=1 (positive). v3.27.5 swapped the gesture from alt-click
   *  to right-click. */
  negative: boolean;
}

export interface BoxArgs {
  frameIdx: number;
  box: [number, number, number, number];
}

export interface TextArgs {
  frameIdx: number;
  text: string;
}

// (auto-preview removed; see clickAt for rationale)
// v3.27.12 — the makePromptSignal abort helper was removed too; rapid
// clicks were canceling the previous in-flight prompt and surfacing
// "track click failed: cancel" toasts. Each prompt is now an
// independent request.

export class TrackTool {
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
      // v3.27.12 — also wipe the visual marker dots so they don't
      // linger after the user discards the session.
      useSamTrackBridge.getState().setMarkers([]);
      useTrackBridge.getState().reset();
    }
  }

  async clickAt(args: ClickArgs): Promise<void> {
    await this.ensureSession();
    const sid = useTrackBridge.getState().sessionId!;
    const hitId = useTrackBridge.getState().hitTest(args.frameIdx, args.x, args.y);
    // Right-click anywhere = negative refinement. If the click lands on
    // an existing mask, refine that obj_id; otherwise auto-route to the
    // most recently seeded obj on this frame so the user doesn't need
    // to manually select a target before negative-clicking.
    const isRefine = hitId !== null || args.negative;
    const label = args.negative ? 0 : 1;

    // v3.27 fix — native SAM 3.1 multiplex requires obj_id to be EXPLICIT
    // for point/box prompts (only text auto-allocates per detection).
    // Omitting obj_id raised:
    //   AssertionError: When points are provided, obj_id must be provided.
    // Allocate the next free id client-side BEFORE the request so the
    // response masks land in the right bridge slot.
    let targetObjId: number;
    if (hitId !== null) {
      // Click landed on an existing mask — refine that obj_id.
      targetObjId = hitId;
    } else if (args.negative) {
      // Negative click on empty canvas — refine the most recently
      // registered object so the click can subtract from its mask
      // without forcing the user to first select the target.
      const objs = Array.from(useTrackBridge.getState().objects.values());
      if (objs.length === 0) {
        throw new Error("track_tool_negative_without_object");
      }
      targetObjId = objs[objs.length - 1].objId;
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

    // v3.27.12 — paint the green/red dot BEFORE awaiting the network
    // round-trip so the user sees instant feedback. If the request
    // later fails the marker stays (the user can right-click again to
    // subtract or remove the object); we DON'T roll it back because a
    // missing dot would look like the click was ignored.
    const frameId = this.getFrameId(args.frameIdx);
    useSamTrackBridge.getState().pushMarker({
      objId: targetObjId,
      x: args.x,
      y: args.y,
      label: label as 0 | 1,
      frameId,
    });

    // v3.27.12 — no abort signal. The previous makePromptSignal() abort
    // was a leftover from the removed auto-preview path; under rapid
    // clicks it canceled the previous request and surfaced
    // "track click failed: cancel" toasts. Each click is now self-
    // contained, so consecutive clicks just queue at the server.
    const resp = await trackApi.prompt(this.assetId, sid, body);
    this.applyMasks(resp);
    // v3.27 — auto-preview removed. The native multiplex predictor's
    // ``propagate_in_video_preflight`` raises an AssertionError when
    // propagate is called twice in close succession (the second call's
    // input frame indices disagree with the first call's consolidated
    // ones). The notebook's intended workflow is: add prompts → run
    // propagate ONCE on Run Full Track. The mask returned by add_prompt
    // already renders on the canvas via applyMasks, so the user sees
    // immediate feedback on the prompted frame without needing preview.
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
    });
    this.applyMasks(resp);
    // v3.27 — auto-preview removed. The native multiplex predictor's
    // ``propagate_in_video_preflight`` raises an AssertionError when
    // propagate is called twice in close succession (the second call's
    // input frame indices disagree with the first call's consolidated
    // ones). The notebook's intended workflow is: add prompts → run
    // propagate ONCE on Run Full Track. The mask returned by add_prompt
    // already renders on the canvas via applyMasks, so the user sees
    // immediate feedback on the prompted frame without needing preview.
  }

  async addText(args: TextArgs): Promise<void> {
    await this.ensureSession();
    const sid = useTrackBridge.getState().sessionId!;
    const classId = this.getActiveClassId();
    if (classId === null) throw new Error("track_tool_no_active_class");
    const resp = await trackApi.prompt(this.assetId, sid, {
      frame_idx: args.frameIdx, text: args.text,
    });
    this.applyMasks(resp);
    for (const k of Object.keys(resp.masks)) {
      const objId = Number(k);
      if (Number.isFinite(objId)) {
        useTrackBridge.getState().registerObject({
          objId, classId, seedFrame: args.frameIdx, seedKind: "text",
        });
      }
    }
    // v3.27 — auto-preview removed. The native multiplex predictor's
    // ``propagate_in_video_preflight`` raises an AssertionError when
    // propagate is called twice in close succession (the second call's
    // input frame indices disagree with the first call's consolidated
    // ones). The notebook's intended workflow is: add prompts → run
    // propagate ONCE on Run Full Track. The mask returned by add_prompt
    // already renders on the canvas via applyMasks, so the user sees
    // immediate feedback on the prompted frame without needing preview.
  }

  async removeObject(objId: number): Promise<void> {
    const sid = useTrackBridge.getState().sessionId;
    if (!sid) return;
    await trackApi.removeObject(this.assetId, sid, objId);
    useTrackBridge.getState().removeObject(objId);
  }

  /** v3.27.5 — NDJSON streaming. The model's
   *  ``propagate_in_video`` runs SAM2 across every frame in one
   *  upstream call, but emits per-frame outputs as it goes; the
   *  /propagate/stream endpoint forwards each frame as a JSON line so
   *  the browser can call applyMasks + tick the progress bar in real
   *  time instead of waiting ~90s for one giant blob. */
  async runFullTrack(): Promise<void> {
    const sid = useTrackBridge.getState().sessionId;
    if (!sid) throw new Error("track_tool_no_session");
    const bridge = useTrackBridge.getState();
    // The native multiplex predictor needs ``start_frame_index`` to
    // locate prompts in tracker_metadata for point/box obj_ids; without
    // it, propagation raises "No prompts are received on any frames".
    const objs = Array.from(bridge.objects.values());
    const startFrame = objs.length > 0
      ? Math.min(...objs.map((o) => o.seedFrame))
      : 0;
    // v3.27.10 — drop every auto-committed seed-click draft for the
    // tracked obj_ids before propagation re-creates them. Without this
    // the user sees TWO polygons on the seed frame: one from the
    // initial click's add_prompt response, one from the propagation
    // stream's frame=seedFrame entry. The deterministic tempId
    // ``track:{trackId}:{frameId}`` is supposed to dedupe via
    // ``annotations.update``, but in practice the seed draft can land
    // in byId under a different key once the save flow assigns a
    // serverId, breaking the lookup. Sweep them up explicitly so the
    // propagation's polygons land cleanly.
    const annotations = useAnnotations.getState();
    const trackIdsToWipe = new Set<string>();
    for (const o of objs) {
      const tid = bridge.trackIds.get(o.objId);
      if (tid) trackIdsToWipe.add(tid);
    }
    if (trackIdsToWipe.size > 0) {
      const drop: string[] = [];
      for (const a of Object.values(annotations.byId)) {
        if (a.trackId && trackIdsToWipe.has(a.trackId)) drop.push(a.tempId);
      }
      if (drop.length > 0) {
        const removeMany = (annotations as { removeMany?: (ids: string[]) => void }).removeMany;
        if (typeof removeMany === "function") removeMany(drop);
        else for (const id of drop) annotations.remove?.(id);
      }
    }
    bridge.setStatus("running");
    bridge.setFramesPropagated(0);
    let processed = 0;
    let committed = 0;
    await trackApi.propagateStream(
      this.assetId,
      sid,
      { start_frame: startFrame },
      (frame) => {
        if (Object.keys(frame.masks ?? {}).length > 0) committed += 1;
        this.applyMasks(frame);
        processed += 1;
        // Tick after every frame so the progress bar stays live; React
        // batches the re-render anyway.
        useTrackBridge.getState().setFramesPropagated(processed);
      },
    );
    // eslint-disable-next-line no-console
    console.debug(
      `[track] runFullTrack stream done: ${committed}/${processed} frames had masks`,
    );
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
