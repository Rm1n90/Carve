// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";

export interface OpenSessionResp {
  session_id: string;
  frame_count: number;
}

export interface RleMask {
  counts: string;
  size: [number, number];
  polygon: [number, number][];
}

export interface FrameMasks {
  frame_idx: number;
  masks: Record<number, RleMask>;
}

export interface PromptIn {
  frame_idx: number;
  obj_id?: number;
  text?: string;
  points?: [number, number][];
  labels?: number[];
  box?: [number, number, number, number];
}

export interface PropagateOpts {
  start_frame?: number;
  end_frame?: number;
}

export interface PropagateResp {
  frames: FrameMasks[];
}

export const trackApi = {
  open: async (assetId: string): Promise<OpenSessionResp> =>
    (await api.post<OpenSessionResp>(`/assets/${assetId}/track/sessions`)).data,

  prompt: async (
    assetId: string,
    sid: string,
    body: PromptIn,
    signal?: AbortSignal,
  ): Promise<FrameMasks> =>
    (
      await api.post<FrameMasks>(
        `/assets/${assetId}/track/sessions/${sid}/prompts`,
        body,
        { signal },
      )
    ).data,

  propagate: async (
    assetId: string,
    sid: string,
    opts: PropagateOpts,
    signal?: AbortSignal,
  ): Promise<PropagateResp> =>
    (
      await api.post<PropagateResp>(
        `/assets/${assetId}/track/sessions/${sid}/propagate`,
        opts,
        { signal },
      )
    ).data,

  removeObject: async (
    assetId: string, sid: string, objId: number,
  ): Promise<void> => {
    await api.delete(`/assets/${assetId}/track/sessions/${sid}/objects/${objId}`);
  },

  resetPrompts: async (assetId: string, sid: string): Promise<void> => {
    await api.delete(`/assets/${assetId}/track/sessions/${sid}/prompts`);
  },

  close: async (assetId: string, sid: string): Promise<void> => {
    await api.delete(`/assets/${assetId}/track/sessions/${sid}`);
  },

  bulkDeleteByTrackIds: async (
    assetId: string, trackIds: string[],
  ): Promise<{ deleted: number }> =>
    (
      await api.delete<{ deleted: number }>(
        `/assets/${assetId}/annotations:by-track-ids`,
        { data: { track_ids: trackIds } },
      )
    ).data,
};
