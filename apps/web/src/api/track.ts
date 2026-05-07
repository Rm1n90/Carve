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

  /** v3.27.5 — NDJSON streaming variant. Calls the per-frame stream
   *  endpoint and invokes ``onFrame`` as each line arrives so the
   *  caller can update progress without waiting for the full sweep
   *  to finish. The returned promise resolves once the stream closes
   *  (server emits a final ``__error__`` line on failure, in which
   *  case it rejects with that error). */
  propagateStream: async (
    assetId: string,
    sid: string,
    opts: PropagateOpts,
    onFrame: (frame: FrameMasks) => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    const baseURL = (import.meta.env.VITE_API_BASE ?? "/api") as string;
    const token = localStorage.getItem("vaa.accessToken");
    const r = await fetch(
      `${baseURL}/assets/${assetId}/track/sessions/${sid}/propagate/stream`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(opts ?? {}),
        signal,
      },
    );
    if (!r.ok || !r.body) {
      const text = await r.text().catch(() => "");
      throw new Error(`propagate_stream HTTP ${r.status}: ${text}`);
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // NDJSON: parse every newline-terminated record; keep the
        // unterminated tail in the buffer.
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line.length > 0) {
            const obj = JSON.parse(line);
            if (obj.__error__) {
              throw new Error(`propagate_stream: ${obj.__error__}`);
            }
            onFrame(obj as FrameMasks);
          }
          nl = buffer.indexOf("\n");
        }
      }
      // Flush any trailing record without a newline.
      const tail = buffer.trim();
      if (tail.length > 0) {
        const obj = JSON.parse(tail);
        if (obj.__error__) {
          throw new Error(`propagate_stream: ${obj.__error__}`);
        }
        onFrame(obj as FrameMasks);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* noop */ }
    }
  },

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
