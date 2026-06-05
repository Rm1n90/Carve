// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";

export interface SystemOSInfo {
  name: string;
  distro: string | null;
  hostname: string;
  architecture: string;
  python_version: string;
  uptime_seconds: number;
}

export interface SystemCPUInfo {
  model: string | null;
  physical_cores: number;
  logical_cores: number;
  frequency_mhz_current: number | null;
  frequency_mhz_min: number | null;
  frequency_mhz_max: number | null;
  load_percent: number;
  per_core_percent: number[];
}

export interface SystemMemoryInfo {
  total_bytes: number;
  available_bytes: number;
  used_bytes: number;
  free_bytes: number;
  percent: number;
  swap_total_bytes: number;
  swap_used_bytes: number;
  swap_percent: number;
}

export interface SystemDiskPartition {
  mountpoint: string;
  fstype: string;
  total_bytes: number;
  used_bytes: number;
  free_bytes: number;
  percent: number;
}

export interface SystemGPUInfo {
  index: number;
  name: string;
  driver_version: string | null;
  memory_total_mb: number;
  memory_used_mb: number;
  memory_free_mb: number;
  memory_percent: number;
  utilization_percent: number | null;
  temperature_c: number | null;
}

export interface SystemInfo {
  os: SystemOSInfo;
  cpu: SystemCPUInfo;
  memory: SystemMemoryInfo;
  disks: SystemDiskPartition[];
  gpus: SystemGPUInfo[];
  collected_at: string;
}

export interface UnloadModelsResponse {
  sam_evicted: string[];
  sam_sessions_released: number;
  fo1_evicted: boolean;
  // v3.22 — measured GPU MB freed (delta of torch.cuda.memory_reserved
  // before/after). Null when CUDA isn't available. Surface this in the
  // toast so the user gets a true number even when bookkeeping says
  // "nothing was loaded".
  sam_freed_mb?: number | null;
  fo1_freed_mb?: number | null;
}

// Result of the admin "Free memory" button. Frees BOTH the server's
// model memory (VRAM + the RAM the model services hold) and returns
// freed heap to the OS so the host RAM gauge actually drops.
export interface FreeMemoryResponse {
  // Host RAM reclaimed = rise in available memory (after − before),
  // clamped at 0. Reported with the absolute before/after so the UI can
  // show the real picture even when concurrent load masks the delta.
  ram_freed_mb: number;
  ram_available_before_mb: number;
  ram_available_after_mb: number;
  ram_total_mb: number;
  ram_percent_after: number;
  // Sum of GPU MB freed across SAM + FO1 + YOLO/YOLOE. Null when CUDA
  // isn't available on any side.
  vram_freed_mb: number | null;
  // Human-readable list of what was unloaded, e.g.
  // ["sam:image", "fo1", "yolo:w1", "yoloe:text"].
  models_evicted: string[];
  malloc_trimmed: boolean;
}

export const systemApi = {
  info: async (): Promise<SystemInfo> =>
    (await api.get<SystemInfo>("/system/info")).data,
  // v3.22 — admin-only manual unload. Returns what each subsystem
  // (SAM image / SAM tracker / FO1 sidecar) actually evicted.
  unloadModels: async (): Promise<UnloadModelsResponse> =>
    (await api.post<UnloadModelsResponse>("/system/unload-models")).data,
  // Admin-only "Free memory". Unloads every model AND returns freed heap
  // to the OS (malloc_trim), reporting host RAM + VRAM reclaimed.
  freeMemory: async (): Promise<FreeMemoryResponse> =>
    (await api.post<FreeMemoryResponse>("/system/free-memory")).data,
};
