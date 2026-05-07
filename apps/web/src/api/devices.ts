// Armin Mehri — mehri.armin@gmail.com
/**
 * Compute device manager client (v3.25).
 *
 * Talks to the api service's `/devices/*` proxy, which forwards to the
 * model container. Returns rich resolution objects so the UI can
 * surface accurate "we did X because Y" messages when the user picks
 * a device that isn't usable.
 */
import { api } from "./client";

export type DeviceKind = "cuda" | "mps" | "cpu";
export type ModelKind = "sam" | "yolo" | "yoloe";

export interface DeviceInfo {
  id: string;
  kind: DeviceKind;
  name: string;
  available: boolean;
  total_mb: number;
  free_mb: number;
  reason: string;
}

export interface DeviceResolution {
  device: string;
  requested: string;
  fallback_used: boolean;
  reason: string;
  recommended: string;
}

export interface ModelDeviceStatus {
  kind: ModelKind;
  preference: string; // "auto" or e.g. "cuda:0"
  resolution: DeviceResolution;
}

export interface DevicesStatus {
  devices: DeviceInfo[];
  recommended: string;
  models: ModelDeviceStatus[];
  /** Per-model minimum free VRAM threshold (MiB) for OOM rejection. */
  min_free_mb: Record<string, number>;
}

export interface SetPreferenceResponse {
  kind: ModelKind;
  preference: string;
  resolution: DeviceResolution;
  fallback_used: boolean;
  reason: string;
}

export interface SamReloadResponse {
  evicted: boolean;
  device: string;
  fallback_used: boolean;
  reason: string;
  recommended: string;
}

export const devicesApi = {
  status: (): Promise<DevicesStatus> =>
    api.get("/devices/status").then((r) => r.data),
  setPreference: (
    kind: ModelKind,
    device: string,
  ): Promise<SetPreferenceResponse> =>
    api.post("/devices/preference", { kind, device }).then((r) => r.data),
  samReload: (): Promise<SamReloadResponse> =>
    api.post("/devices/sam/reload").then((r) => r.data),
};
