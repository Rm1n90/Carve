import { api } from "./client";

export interface TrackStartResult {
  session_id: string;
  mask_at_start: { counts: string; size: [number, number] };
}

export interface TrackStep {
  frame_idx: number;
  counts: string;
  size: [number, number];
  score: number;
}

export interface TrackStepResult {
  steps: TrackStep[];
}

export const samTrackApi = {
  start: async (
    assetId: string,
    frameIdx: number,
    points: [number, number][],
    labels: number[],
  ): Promise<TrackStartResult> =>
    (
      await api.post<TrackStartResult>(`/assets/${assetId}/sam-track/start`, {
        frame_idx: frameIdx,
        points,
        labels,
      })
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
