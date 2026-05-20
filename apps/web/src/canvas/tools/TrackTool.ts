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
  /** Single-flight guard for ``openSession``. Without this, rapid clicks
   *  before the first round-trip lands each fire their own
   *  ``trackApi.open`` and the model service's single-session policy
   *  evicts the prior session each time, racing prompts against
   *  eviction and surfacing as "delay then a burst of clicks". */
  private openInFlight: Promise<void> | null = null;
  /** Last-opened window's absolute [start, end] frame range so the
   *  auto-track loop can snapshot the end-frame masks and compute the
   *  next window without re-querying the panel. ``null`` between
   *  sessions. */
  private currentWindow: { startFrame: number; endFrame: number } | null = null;
  /** Cooperative flag for the auto-track loop. Set true by
   *  ``cancelAutoTrack`` (Stop button → closeSession). The loop checks
   *  before each window so the user can interrupt cleanly. */
  private autoTrackCanceled = false;

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

  async openSession(opts: {
    startFrame?: number;
    endFrame?: number;
  } = {}): Promise<void> {
    if (this.isActive()) return;
    if (this.openInFlight) {
      await this.openInFlight;
      return;
    }
    // Defensive: clear any stale bridge state BEFORE opening so a
    // phantom object from a previous session (e.g. seedFrame=0 from
    // window [0, 499] surviving into window [1002, 1501]) doesn't
    // appear in the new session's object list.
    const bridgeNow = useTrackBridge.getState();
    if (bridgeNow.objects.size > 0 || bridgeNow.masksByFrame.size > 0) {
      bridgeNow.reset();
    }
    useSamTrackBridge.getState().setMarkers([]);
    this.openInFlight = (async () => {
      try {
        if (this.isActive()) return;
        const r = await trackApi.open(this.assetId, opts);
        useTrackBridge.getState().setSession(
          r.session_id, r.frame_count, r.start_frame, r.end_frame,
        );
        // The API returns the resolved window bounds — mirror them
        // on the TrackTool instance AND the bridge so any other
        // TrackTool instance (after a panel remount) can recover the
        // window from the bridge without re-opening.
        this.currentWindow = {
          startFrame: r.start_frame,
          endFrame: r.end_frame,
        };
      } finally {
        this.openInFlight = null;
      }
    })();
    await this.openInFlight;
  }

  /** Recover the open window from the bridge — used by auto-track when
   *  the TrackTool instance was just created (panel remount) but the
   *  session is still alive server-side. */
  private getCurrentWindow(): { startFrame: number; endFrame: number } | null {
    if (this.currentWindow) return this.currentWindow;
    const s = useTrackBridge.getState();
    if (s.sessionId && s.windowStart !== null && s.windowEnd !== null) {
      this.currentWindow = {
        startFrame: s.windowStart,
        endFrame: s.windowEnd,
      };
      return this.currentWindow;
    }
    return null;
  }

  /** Abort the in-flight auto-track loop (Stop button → closeSession
   *  → this). Sets the cooperative flag and aborts the streaming fetch
   *  so the next iteration check exits cleanly. */
  cancelAutoTrack(): void {
    this.autoTrackCanceled = true;
    this.abortRun();
  }

  async closeSession(): Promise<void> {
    // Abort the in-flight runFullTrack stream (if any) so the model
    // service doesn't keep emitting masks for a session that's about
    // to be deleted. Do NOT touch ``autoTrackCanceled`` here — the
    // auto-track loop calls closeSession between windows, and flipping
    // that flag would make the loop's next safety check bail out
    // mid-chain. The panel's Stop button is responsible for calling
    // ``cancelAutoTrack`` separately before closeSession.
    this.abortRun();
    const sid = useTrackBridge.getState().sessionId;
    if (!sid) {
      this.currentWindow = null;
      return;
    }
    try {
      await trackApi.close(this.assetId, sid);
    } finally {
      // v3.27.12 — also wipe the visual marker dots so they don't
      // linger after the user discards the session.
      useSamTrackBridge.getState().setMarkers([]);
      useTrackBridge.getState().reset();
      this.currentWindow = null;
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
    let registeredNewObject = false;
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
      registeredNewObject = true;
    }

    // Paint the green/red dot BEFORE awaiting the network round-trip
    // so the user sees instant feedback. If the API call fails we ALSO
    // roll back the optimistically-registered object so a failed click
    // (e.g. 422 "frame outside window") doesn't leave a phantom entry
    // in the object list.
    const frameId = this.getFrameId(args.frameIdx);
    useSamTrackBridge.getState().pushMarker({
      objId: targetObjId,
      x: args.x,
      y: args.y,
      label: label as 0 | 1,
      frameId,
    });

    // Plain point prompt to the multiplex track session. We previously
    // routed every fresh seed click through the SAM image predictor
    // first (encode + decode → bbox → multiplex box prompt) to lift
    // mask quality, but that force-loaded the image predictor onto
    // the SAME GPU as the multiplex tracker (~5 GB baseline). The
    // combined footprint pushed even 250-frame windows over the 24 GB
    // budget when 1 000-frame windows had been working fine before
    // the hybrid path was introduced. For higher-quality seeds the
    // user can DRAG a bbox instead — that path already routes through
    // SAM 3's detector via the multiplex tracker WITHOUT loading the
    // image predictor.
    const body: PromptIn = {
      frame_idx: args.frameIdx,
      obj_id: targetObjId,
      points: [[args.x, args.y]],
      labels: [label],
    };

    try {
      const resp = await trackApi.prompt(this.assetId, sid, body);
      this.applyMasks(resp);
    } catch (err) {
      if (registeredNewObject) {
        // Roll back: remove the bridge entry and its track id so the
        // panel's object list reflects only what the server confirmed.
        useTrackBridge.getState().removeObject(targetObjId);
      }
      throw err;
    }
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

    try {
      const resp = await trackApi.prompt(this.assetId, sid, {
        frame_idx: args.frameIdx,
        obj_id: targetObjId,
        box: args.box,
      });
      this.applyMasks(resp);
    } catch (err) {
      // Roll back so a failed box prompt doesn't leave a phantom entry
      // in the panel's object list (e.g. 422 "frame outside window").
      useTrackBridge.getState().removeObject(targetObjId);
      throw err;
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

  /** AbortController for the currently-streaming runFullTrack. ``null``
   *  when no propagation is in flight. Calling ``abortRun`` aborts the
   *  fetch reader so the model service's NDJSON stream is dropped; the
   *  session itself stays alive (the user can re-prompt without paying
   *  another 40 s warm-up). */
  private runAbortController: AbortController | null = null;

  /** Abort the in-flight ``runFullTrack`` streaming response. Session
   *  is preserved — only the propagation read loop ends. Safe no-op
   *  when no run is in flight. */
  abortRun(): void {
    const ac = this.runAbortController;
    if (!ac) return;
    try {
      ac.abort();
    } catch {
      /* ignore */
    }
  }

  /** True while a runFullTrack stream is still consuming. */
  isRunning(): boolean {
    return this.runAbortController !== null;
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
    const ac = new AbortController();
    this.runAbortController = ac;
    try {
      await trackApi.propagateStream(
        this.assetId,
        sid,
        { start_frame: startFrame },
        (frame) => {
          if (Object.keys(frame.masks ?? {}).length > 0) committed += 1;
          this.applyMasks(frame);
          processed += 1;
          // Tick after every frame so the progress bar stays live;
          // React batches the re-render anyway.
          useTrackBridge.getState().setFramesPropagated(processed);
        },
        ac.signal,
      );
      // eslint-disable-next-line no-console
      console.debug(
        `[track] runFullTrack stream done: ${committed}/${processed} frames had masks`,
      );
      useTrackBridge.getState().setStatus("done");
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (
        ac.signal.aborted
        || e?.name === "AbortError"
        || (typeof e?.message === "string" && /abort/i.test(e.message))
      ) {
        // Operator-requested stop — keep what's been committed and
        // mark the bridge as idle so the UI can re-prompt without
        // looking like it failed.
        useTrackBridge.getState().setStatus("idle");
        return;
      }
      useTrackBridge.getState().setStatus("failed", (err as Error).message);
      throw err;
    } finally {
      if (this.runAbortController === ac) this.runAbortController = null;
    }
  }

  /**
   * Auto-chain windows from the current open session to the end of the
   * video. Snapshots the end-frame mask of every tracked obj_id,
   * computes a tight bbox for each, closes the current session, opens
   * the next window, seeds with those bboxes (routed through SAM 3
   * detector for high-quality re-segmentation), and propagates again.
   *
   * Stops cleanly when:
   *   - the next-window start passes ``opts.lastFrame`` (covered the
   *     whole video),
   *   - the user clicks Stop (``cancelAutoTrack`` flips
   *     ``autoTrackCanceled``),
   *   - three consecutive windows produce zero valid hand-off bboxes
   *     (every tracked object was lost — likely occluded or
   *     mis-tracked), or
   *   - any propagation throws a non-abort error.
   *
   * Returns ``{ windowsCompleted, framesTracked, reason }`` so the
   * caller can render a final summary toast.
   */
  async autoTrackToEnd(opts: {
    lastFrame: number;
    windowSize: number;
  }): Promise<{
    windowsCompleted: number;
    framesTracked: number;
    reason: "end_of_video" | "canceled" | "lost_objects" | "gpu_exhausted" | "error";
  }> {
    const currentWindow = this.getCurrentWindow();
    if (!currentWindow) {
      throw new Error("auto_track_requires_open_session");
    }
    const lastFrame = Math.max(0, Math.floor(opts.lastFrame));
    const windowSize = Math.max(10, Math.floor(opts.windowSize));
    this.autoTrackCanceled = false;
    // The initial window has already been propagated by the user via
    // "Run full track" — autoTrackToEnd picks up FROM there.
    let windowsCompleted = 1;
    let framesTracked =
      currentWindow.endFrame - currentWindow.startFrame + 1;
    let consecutiveLostObjects = 0;

    // Tell the bridge so the badge can show "auto-tracking window N / M".
    const initialEnd = currentWindow.endFrame;
    const remaining = Math.max(0, lastFrame - initialEnd);
    const totalWindows = 1 + Math.ceil(remaining / windowSize);
    useTrackBridge.getState().setAutoTracking({
      autoTracking: true,
      autoTotalWindows: totalWindows,
      autoCompletedWindows: 1,
      autoLastFrame: lastFrame,
    });

    try {
      while (!this.autoTrackCanceled) {
        // Re-resolve each iteration in case a panel remount happened
        // between windows (the helper falls back to bridge state).
        const liveWindow = this.getCurrentWindow();
        if (!liveWindow) break;
        const currentEnd = liveWindow.endFrame;
        if (currentEnd >= lastFrame) {
          return {
            windowsCompleted,
            framesTracked,
            reason: "end_of_video",
          };
        }

        // 1. Snapshot end-frame masks per tracked obj_id and convert to
        //    tight bboxes. Drop entries whose bbox is degenerate or
        //    obviously wrong (covers >40 % of the frame area — a SAM 3
        //    failure mode; propagating a giant bbox would corrupt the
        //    rest of the video).
        const bridge = useTrackBridge.getState();
        const endMasks = bridge.masksByFrame.get(currentEnd);
        const seeds: Array<{
          classId: string;
          bbox: [number, number, number, number];
        }> = [];
        if (endMasks) {
          for (const [objId, obj] of bridge.objects) {
            const mask = endMasks.get(objId);
            if (!mask || !mask.polygon || mask.polygon.length < 3) continue;
            const bbox = tightBboxOfPolygon(mask.polygon);
            if (!bbox) continue;
            const [x1, y1, x2, y2] = bbox;
            const [imgH, imgW] = mask.size;
            const area = (x2 - x1) * (y2 - y1);
            const frameArea = imgH * imgW;
            if (
              frameArea > 0
              && area > 0.4 * frameArea
            ) {
              // Skip — SAM 3 detector with such a wide hint will likely
              // re-produce the same oversized mask.
              continue;
            }
            seeds.push({ classId: obj.classId, bbox });
          }
        }

        if (seeds.length === 0) {
          consecutiveLostObjects += 1;
          if (consecutiveLostObjects >= 3) {
            return {
              windowsCompleted,
              framesTracked,
              reason: "lost_objects",
            };
          }
        } else {
          consecutiveLostObjects = 0;
        }

        // 2. Compute next window.
        const nextStart = currentEnd + 1;
        const nextEnd = Math.min(nextStart + windowSize - 1, lastFrame);
        if (nextStart > lastFrame) {
          return {
            windowsCompleted,
            framesTracked,
            reason: "end_of_video",
          };
        }

        // 3. Close current session + drain GPU (server-side); open the
        //    next window. The single-session policy in the model
        //    service evicts the prior session as a backup. closeSession
        //    no longer flips ``autoTrackCanceled`` so the loop can chain
        //    freely; the panel's Stop button is the only caller that
        //    sets that flag.
        await this.closeSession();
        if (this.autoTrackCanceled) {
          return {
            windowsCompleted,
            framesTracked,
            reason: "canceled",
          };
        }
        await this.openSession({
          startFrame: nextStart,
          endFrame: nextEnd,
        });
        if (this.autoTrackCanceled) {
          return {
            windowsCompleted,
            framesTracked,
            reason: "canceled",
          };
        }

        // 4. Re-seed each surviving object at the new window's first
        //    frame using its hand-off bbox. The multiplex box path goes
        //    through SAM 3 detector → matches image-mode quality.
        const sid = useTrackBridge.getState().sessionId;
        if (!sid) {
          return {
            windowsCompleted,
            framesTracked,
            reason: "error",
          };
        }
        for (const seed of seeds) {
          if (this.autoTrackCanceled) {
            return {
              windowsCompleted,
              framesTracked,
              reason: "canceled",
            };
          }
          const targetObjId = nextFreeObjId();
          useTrackBridge.getState().registerObject({
            objId: targetObjId,
            classId: seed.classId,
            seedFrame: nextStart,
            seedKind: "box",
          });
          try {
            const resp = await trackApi.prompt(this.assetId, sid, {
              frame_idx: nextStart,
              obj_id: targetObjId,
              box: seed.bbox,
            });
            this.applyMasks(resp);
          } catch (err) {
            // Bad seed — remove the registration and skip. The loop
            // continues with the surviving seeds.
            useTrackBridge.getState().removeObject(targetObjId);
            // eslint-disable-next-line no-console
            console.warn(
              `[track] auto-track seed failed for class ${seed.classId}:`,
              (err as Error).message,
            );
          }
        }

        const aliveAfterSeeding = useTrackBridge.getState().objects.size;
        if (aliveAfterSeeding === 0) {
          consecutiveLostObjects += 1;
          if (consecutiveLostObjects >= 3) {
            return {
              windowsCompleted,
              framesTracked,
              reason: "lost_objects",
            };
          }
          // Still try to propagate? Without objects there's nothing to
          // track — fall through; runFullTrack will no-op and we'll
          // advance to the next window.
        }

        // 5. Propagate the new window. Catch GPU OOM specifically —
        //    each window is independent so we can stop the loop with
        //    a clear actionable message instead of bubbling a generic
        //    error that ends the whole flow.
        try {
          await this.runFullTrack();
        } catch (err) {
          const e = err as {
            errorCode?: string;
            code?: number;
            message?: string;
          };
          if (
            e?.errorCode === "track_gpu_exhausted"
            || e?.code === 507
            || (typeof e?.message === "string"
                && /gpu memory exhausted|out of memory/i.test(e.message))
          ) {
            // eslint-disable-next-line no-console
            console.warn("[track] auto-track stopped on GPU OOM:", e.message);
            return {
              windowsCompleted,
              framesTracked,
              reason: "gpu_exhausted",
            };
          }
          throw err;
        }
        if (this.autoTrackCanceled) {
          return {
            windowsCompleted,
            framesTracked,
            reason: "canceled",
          };
        }

        windowsCompleted += 1;
        framesTracked += nextEnd - nextStart + 1;
        useTrackBridge.getState().setAutoTracking({
          autoTracking: true,
          autoCompletedWindows: windowsCompleted,
        });
      }

      return {
        windowsCompleted,
        framesTracked,
        reason: "canceled",
      };
    } finally {
      // Always release the auto-track UI flag on exit so the panel
      // returns to its single-window state.
      useTrackBridge.getState().setAutoTracking({ autoTracking: false });
    }
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

/** Tight axis-aligned bbox of a polygon: ``[x1, y1, x2, y2]``. Returns
 *  ``null`` when the polygon is degenerate (< 3 points or zero area). */
function tightBboxOfPolygon(
  polygon: [number, number][],
): [number, number, number, number] | null {
  if (!polygon || polygon.length < 3) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const [x, y] of polygon) {
    if (x < x1) x1 = x;
    if (y < y1) y1 = y;
    if (x > x2) x2 = x;
    if (y > y2) y2 = y;
  }
  if (!Number.isFinite(x1) || x2 - x1 < 2 || y2 - y1 < 2) return null;
  return [x1, y1, x2, y2];
}
