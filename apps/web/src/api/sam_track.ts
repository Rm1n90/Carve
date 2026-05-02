// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";

export interface TrackStartResult {
  session_id: string;
  mask_at_start: { counts: string; size: [number, number] };
}

/** Per-object mask at a specific frame. */
export interface TrackObjectStep {
  obj_id: number;
  counts: string;
  size: [number, number];
  score: number;
  // v3.8 Phase 4.1 -- Douglas-Peucker simplified outer contour. Empty
  // when the mask had no usable contour; client falls back to mask_rle.
  polygon: [number, number][];
}

/** A frame's masks for all tracked objects. */
export interface TrackFrameStep {
  frame_idx: number;
  objects: TrackObjectStep[];
}

export interface TrackStepResult {
  steps: TrackFrameStep[];
}

export interface AddObjectIn {
  frame_idx: number;
  obj_id?: number;
  points?: [number, number][];
  labels?: number[];
  boxes?: [number, number, number, number][];
  text?: string;
}

/** Response when seeding by point/box prompts — server echoes obj_id. */
export interface AddObjectByPointOrBoxOut {
  obj_id: number;
  frame_idx: number;
}

/**
 * Plan 11 Task 5 — multiplex text seeding can yield multiple obj_ids
 * (one per detection in the concept's response).
 */
export interface AddObjectByTextOut {
  obj_ids: number[];
  frame_idx: number;
}

export type AddObjectOut = AddObjectByPointOrBoxOut | AddObjectByTextOut;

export const samTrackApi = {
  /**
   * Open a new tracking session. Points/labels are optional — pass empty arrays
   * to start a multi-object workflow where each object is added afterward via
   * ``addObject``. ``text`` is forwarded to the model service for SAM 3 callers.
   */
  start: async (
    assetId: string,
    frameIdx: number,
    points: [number, number][] = [],
    labels: number[] = [],
    text?: string,
  ): Promise<TrackStartResult> =>
    (
      await api.post<TrackStartResult>(`/assets/${assetId}/sam-track/start`, {
        frame_idx: frameIdx,
        points,
        labels,
        text: text ?? null,
      })
    ).data,

  /**
   * Add a tracked object to an existing session.
   *
   * - When ``body.text`` is set, the multiplex backend auto-assigns one or
   *   more obj_ids and returns them as ``{obj_ids, frame_idx}``.
   * - Otherwise the server echoes the requested ``{obj_id, frame_idx}``.
   */
  addObject: async (
    assetId: string,
    sessionId: string,
    body: AddObjectIn,
  ): Promise<AddObjectOut> =>
    (
      await api.post<AddObjectOut>(
        `/assets/${assetId}/sam-track/${sessionId}/objects`,
        body,
      )
    ).data,

  /**
   * Plan 11 Task 4 — remove a single object from an active multiplex
   * session. 404 → unknown obj_id, 422 → adapter is not multiplex.
   */
  removeObject: async (
    assetId: string,
    sessionId: string,
    objId: number,
  ): Promise<void> => {
    await api.delete(
      `/assets/${assetId}/sam-track/${sessionId}/objects/${objId}`,
    );
  },

  /**
   * Plan 11 Task 4 — clear all objects from a multiplex session without
   * tearing down the session itself. 422 when the adapter is not multiplex.
   */
  resetSession: async (assetId: string, sessionId: string): Promise<void> => {
    await api.post(`/assets/${assetId}/sam-track/${sessionId}/reset`);
  },

  step: async (
    assetId: string,
    sessionId: string,
    frames: number,
  ): Promise<TrackStepResult> =>
    (
      await api.post<TrackStepResult>(
        `/assets/${assetId}/sam-track/${sessionId}/step?frames=${frames}`,
      )
    ).data,

  release: async (assetId: string, sessionId: string): Promise<void> => {
    await api.delete(`/assets/${assetId}/sam-track/${sessionId}`);
  },
};
