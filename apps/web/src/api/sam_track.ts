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
  obj_id: number;
  points?: [number, number][];
  labels?: number[];
  boxes?: [number, number, number, number][];
}

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

  /** Add a tracked object to an existing session. Returns the assigned obj_id. */
  addObject: async (
    assetId: string,
    sessionId: string,
    body: AddObjectIn,
  ): Promise<{ obj_id: number; frame_idx: number }> =>
    (
      await api.post<{ obj_id: number; frame_idx: number }>(
        `/assets/${assetId}/sam-track/${sessionId}/objects`,
        body,
      )
    ).data,

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
