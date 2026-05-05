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

export const systemApi = {
  info: async (): Promise<SystemInfo> =>
    (await api.get<SystemInfo>("/system/info")).data,
};
