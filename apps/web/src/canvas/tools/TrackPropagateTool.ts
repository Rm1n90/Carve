import { useAnnotations } from "@/state/annotations";
import { samTrackApi, type TrackFrameStep } from "@/api/sam_track";

/**
 * Forward video tracker built on the model service's SAM 2 / SAM 3 video
 * predictor. Supports MULTIPLE tracked objects per session.
 *
 * Workflow (multi-object):
 * 1. ``startEmpty()`` opens a session with no objects.
 * 2. ``addObjectAtFrame(frameIdx, points, labels, classId)`` registers each
 *    target. Returns a stable obj_id (1, 2, 3 ...).
 * 3. ``step(N)`` advances N frames; collects per-frame, per-object masks.
 * 4. ``commit(framesToFrameId)`` writes one mask annotation per (frame, obj_id).
 *    All annotations for the same obj_id share a single client-generated
 *    track_id; classId is taken from whatever was passed to addObjectAtFrame.
 * 5. ``release()`` frees the server session.
 *
 * The legacy single-object ``start({frameIdx, points, labels})`` shape stays
 * as a convenience wrapper that calls ``startEmpty()`` then ``addObjectAtFrame``.
 *
 * Each generated ``track_id`` is forwarded into the ``AnnotationDraft``
 * (via the optional ``trackId`` field) so the per-object grouping survives
 * the save round-trip — the api-side ``AnnotationIn`` schema and the
 * ``annotations.track_id`` column already accept it.
 */
export class TrackPropagateTool {
  private sessionId: string | null = null;
  private collected: TrackFrameStep[] = [];
  private nextObjId = 1;
  /** Map obj_id → classId chosen at the time the object was added. */
  private classByObjId: Map<number, string> = new Map();

  constructor(
    private assetId: string,
    private getActiveClassId: () => string | null,
    private generateTrackId: () => string = () =>
      // v3.8 Phase 4-video step F8 — must be a valid UUID; the API
      // parses with ``uuid.UUID(...)`` and 500s on the legacy
      // ``tr-<base36>`` shape.
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Math.floor(Math.random() * 1e8).toString(16).padStart(8, "0")}-` +
          `${Math.floor(Math.random() * 1e4).toString(16).padStart(4, "0")}-` +
          `4${Math.floor(Math.random() * 1e3).toString(16).padStart(3, "0")}-` +
          `${(8 + Math.floor(Math.random() * 4)).toString(16)}` +
          `${Math.floor(Math.random() * 1e3).toString(16).padStart(3, "0")}-` +
          `${Math.floor(Math.random() * 1e12).toString(16).padStart(12, "0")}`,
    private generateTempId: () => string = () =>
      `t-${Math.random().toString(36).slice(2)}`,
  ) {}

  isActive(): boolean {
    return this.sessionId !== null;
  }

  getCollectedFrames(): TrackFrameStep[] {
    return [...this.collected];
  }

  getObjectIds(): number[] {
    return [...this.classByObjId.keys()];
  }

  /**
   * Open a session with no objects. Use ``addObjectAtFrame`` to add each
   * object's prompts before calling ``step()``.
   */
  async startEmpty(opts?: { frameIdx?: number }): Promise<void> {
    if (this.sessionId !== null) {
      // Already active — release first to avoid leaks
      await this.release();
    }
    const r = await samTrackApi.start(
      this.assetId,
      opts?.frameIdx ?? 0,
      [],
      [],
    );
    this.sessionId = r.session_id;
    this.collected = [];
    this.classByObjId.clear();
    this.nextObjId = 1;
  }

  /**
   * Convenience: start a session and immediately register a first object using
   * the active class. Mirrors the pre-multi-object API.
   */
  async start(opts: {
    frameIdx: number;
    points: [number, number][];
    labels: number[];
  }): Promise<void> {
    await this.startEmpty({ frameIdx: opts.frameIdx });
    const classId = this.getActiveClassId();
    if (!classId) {
      throw new Error("TrackPropagateTool: no active class");
    }
    await this.addObjectAtFrame(
      opts.frameIdx,
      opts.points,
      opts.labels,
      classId,
    );
  }

  /**
   * v3.8 Phase 4.3 — open a SAM 3 *concept* tracking session seeded
   * with a text prompt. The model service binds the prompt to obj_id=1
   * automatically (concept mode does not accept later /objects calls).
   * The classId snapshot is used at commit time so the tracked masks
   * land on the right class.
   */
  async startWithText(
    text: string,
    classId: string,
    opts?: { frameIdx?: number },
  ): Promise<void> {
    if (this.sessionId !== null) {
      await this.release();
    }
    const r = await samTrackApi.start(
      this.assetId,
      opts?.frameIdx ?? 0,
      [],
      [],
      text,
    );
    this.sessionId = r.session_id;
    this.collected = [];
    this.classByObjId.clear();
    this.nextObjId = 2;
    // Concept mode: the server seeds obj_id=1 from the text prompt.
    this.classByObjId.set(1, classId);
  }

  /**
   * Add a new tracked object at a specific frame. Returns the assigned obj_id.
   * The session must already be open. The classId snapshot is used at commit
   * time so each obj_id's annotations land on the right class.
   */
  async addObjectAtFrame(
    frameIdx: number,
    points: [number, number][],
    labels: number[],
    classId: string,
    boxes?: [number, number, number, number][],
  ): Promise<number> {
    if (this.sessionId === null) {
      throw new Error("TrackPropagateTool: not started");
    }
    const sentObjId = this.nextObjId++;
    // v3.8 Phase 4-video step F7 -- boxes are an alternative to points
    // for seeding tracked objects (server's /sam-track/{sid}/objects
    // accepts either or both). When boxes is provided, points/labels
    // are typically empty.
    const body: {
      frame_idx: number;
      obj_id: number;
      points?: [number, number][];
      labels?: number[];
      boxes?: [number, number, number, number][];
    } = {
      frame_idx: frameIdx,
      obj_id: sentObjId,
    };
    if (points && points.length > 0) {
      body.points = points;
      body.labels = labels;
    }
    if (boxes && boxes.length > 0) {
      body.boxes = boxes;
    }
    const response = await samTrackApi.addObject(this.assetId, this.sessionId, body);
    if (response.obj_id !== sentObjId) {
      // Defensive: don't mutate classByObjId — server returned an unexpected
      // id, so the mapping would key off the wrong obj_id at commit() time.
      throw new Error(
        `TrackPropagateTool: obj_id mismatch — sent ${sentObjId}, got ${response.obj_id}`,
      );
    }
    this.classByObjId.set(sentObjId, classId);
    return sentObjId;
  }

  /** Advance N frames; returns the per-frame, per-object steps for this batch. */
  async step(frames: number): Promise<TrackFrameStep[]> {
    if (this.sessionId === null) {
      throw new Error("TrackPropagateTool: not started");
    }
    const r = await samTrackApi.step(this.assetId, this.sessionId, frames);
    this.collected.push(...r.steps);
    return r.steps;
  }

  /**
   * Commit one mask annotation per (frame, obj_id). All masks for the same
   * obj_id share a single track_id; classId is taken from ``classByObjId``.
   * Steps whose frame_idx is missing from ``frameIdxToFrameId`` are dropped.
   * Objects with no class snapshot (i.e. that arrived from /step without a
   * matching addObjectAtFrame call) are also dropped.
   *
   * @returns the number of annotations committed.
   */
  commit(frameIdxToFrameId: Record<number, string>): number {
    const trackByObjId = new Map<number, string>();
    let count = 0;
    for (const frame of this.collected) {
      const fid = frameIdxToFrameId[frame.frame_idx];
      if (!fid) continue;
      for (const obj of frame.objects) {
        const classId = this.classByObjId.get(obj.obj_id);
        if (!classId) continue;
        if (!trackByObjId.has(obj.obj_id)) {
          trackByObjId.set(obj.obj_id, this.generateTrackId());
        }
        const trackId = trackByObjId.get(obj.obj_id)!;
        // v3.8 Phase 4.1 -- emit polygon when the model produced a
        // usable contour so tracked annotations are immediately
        // editable. Falls back to mask_rle when polygon is empty.
        const poly = obj.polygon;
        if (poly && poly.length >= 3) {
          useAnnotations.getState().add({
            tempId: this.generateTempId(),
            classId,
            kind: "polygon",
            geometry: { kind: "polygon", points: poly },
            frameId: fid,
            serverId: null,
            dirty: true,
            trackId,
          });
        } else {
          useAnnotations.getState().add({
            tempId: this.generateTempId(),
            classId,
            kind: "mask",
            geometry: { kind: "mask_rle", size: obj.size, counts: obj.counts },
            frameId: fid,
            serverId: null,
            dirty: true,
            trackId,
          });
        }
        count += 1;
      }
    }
    this.collected = [];
    return count;
  }

  async release(): Promise<void> {
    if (this.sessionId === null) return;
    const sid = this.sessionId;
    this.sessionId = null;
    this.collected = [];
    this.classByObjId.clear();
    this.nextObjId = 1;
    try {
      await samTrackApi.release(this.assetId, sid);
    } catch {
      // Best-effort: server-side session may already be gone.
    }
  }
}
