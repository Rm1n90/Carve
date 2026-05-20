// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";

export interface OpenSessionResp {
  session_id: string;
  /** Number of frames actually loaded into the model session (i.e. the
   *  window size). Equals ``end_frame - start_frame + 1``. */
  frame_count: number;
  /** Absolute asset frame index of the first frame in the window. */
  start_frame: number;
  /** Absolute asset frame index of the last frame in the window. */
  end_frame: number;
}

export interface OpenSessionOpts {
  /** Absolute asset frame index to start the window at (inclusive). */
  startFrame?: number;
  /** Absolute asset frame index to end the window at (inclusive). */
  endFrame?: number;
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

// open_session has to load every extracted frame into the SAM 3.1
// multiplex predictor (~55 frames/sec on a 24 GB GPU). A 2 230-frame
// clip therefore takes ~40 s; bigger clips push past the global 30 s
// axios timeout. Override per-call so the user doesn't see a spurious
// "timeout failed" while the session is genuinely warming.
const TRACK_OPEN_TIMEOUT_MS = 5 * 60_000;
// add_prompt is fast (~100 ms steady-state) but the first call after a
// fresh session can be 2-5 s while torch compiles the prompt path.
const TRACK_PROMPT_TIMEOUT_MS = 60_000;

export const trackApi = {
  open: async (
    assetId: string,
    opts: OpenSessionOpts = {},
  ): Promise<OpenSessionResp> => {
    const body: Record<string, number> = {};
    if (typeof opts.startFrame === "number") body.start_frame = opts.startFrame;
    if (typeof opts.endFrame === "number") body.end_frame = opts.endFrame;
    return (
      await api.post<OpenSessionResp>(
        `/assets/${assetId}/track/sessions`,
        Object.keys(body).length > 0 ? body : undefined,
        { timeout: TRACK_OPEN_TIMEOUT_MS },
      )
    ).data;
  },

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
        { signal, timeout: TRACK_PROMPT_TIMEOUT_MS },
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
    /** Convert a structured ``__error__`` NDJSON record into a thrown
     *  Error that preserves the upstream ``code`` + ``error_code`` so
     *  callers (auto-track loop, etc.) can branch on a 507 / GPU OOM
     *  without string-matching the message. */
    function throwFromErrorLine(obj: {
      __error__: string;
      code?: number;
      error_code?: string;
    }): never {
      const err = new Error(
        `propagate_stream: ${obj.__error__}`,
      ) as Error & { code?: number; errorCode?: string };
      if (typeof obj.code === "number") err.code = obj.code;
      if (typeof obj.error_code === "string") err.errorCode = obj.error_code;
      throw err;
    }
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
              throwFromErrorLine(obj);
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
          throwFromErrorLine(obj);
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
