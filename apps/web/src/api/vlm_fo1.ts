// HTTP wrapper for ``/me/vlm-fo1``. Mirrors the backend router 1:1.
//
// The toggle is a single-boolean per-user preference: when enabled,
// the editor opts into the VLM-FO1 precision filter on the model
// service for /sam/text-prompt and Auto mode requests. The toggle
// is hidden in the UI when the model service reports
// ``vlm_fo1_available=false`` via /models/sam-status.
import { api } from "./client";

export interface VlmFo1Pref {
  enabled: boolean;
}

export const vlmFo1Api = {
  /** Read the calling user's current VLM-FO1 toggle state. */
  get: async (): Promise<VlmFo1Pref> =>
    (await api.get<VlmFo1Pref>("/me/vlm-fo1")).data,

  /**
   * Update the calling user's VLM-FO1 toggle. Server is a no-op when
   * the value is unchanged.
   */
  put: async (enabled: boolean): Promise<VlmFo1Pref> =>
    (
      await api.put<VlmFo1Pref>("/me/vlm-fo1", {
        enabled,
      })
    ).data,
};
