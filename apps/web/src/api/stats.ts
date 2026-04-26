import { api } from "./client";

export interface ClassFrequencyRow {
  class_id: string;
  class_idx: number;
  class_name: string;
  class_color: string;
  count: number;
}

export interface DensityRow {
  frame_id: string;
  count: number;
}

export interface TaskProgress {
  total_frames: number;
  labeled_frames: number;
  progress_pct: number;
}

export interface SizeDistribution {
  small: number;
  medium: number;
  large: number;
}

export type AspectRatioBucket = "<0.33" | "0.33-0.67" | "0.67-1.5" | "1.5-3" | ">=3";
export type AspectRatio = Record<AspectRatioBucket, number>;

export interface Heatmap {
  bins: number;
  grid: number[];
}

export interface TimeOnTaskRow {
  user_id: string;
  email: string;
  seconds: number;
}

export interface ByClassRow {
  class_id: string;
  name: string;
  count: number;
}

export interface TaskProgressRow {
  task_id: string;
  name: string;
  progress_pct: number;
}

export interface ProjectStats {
  totals: { annotations: number; assets: number; tasks: number };
  by_class: ByClassRow[];
  tasks: TaskProgressRow[];
}

export const statsApi = {
  classFrequency: async (taskId: string): Promise<ClassFrequencyRow[]> =>
    (await api.get<ClassFrequencyRow[]>(`/tasks/${taskId}/stats/class-frequency`)).data,
  density: async (taskId: string): Promise<DensityRow[]> =>
    (await api.get<DensityRow[]>(`/tasks/${taskId}/stats/density`)).data,
  progress: async (taskId: string): Promise<TaskProgress> =>
    (await api.get<TaskProgress>(`/tasks/${taskId}/stats/progress`)).data,
  sizeDistribution: async (taskId: string): Promise<SizeDistribution> =>
    (await api.get<SizeDistribution>(`/tasks/${taskId}/stats/size-distribution`)).data,
  aspectRatio: async (taskId: string): Promise<AspectRatio> =>
    (await api.get<AspectRatio>(`/tasks/${taskId}/stats/aspect-ratio`)).data,
  heatmap: async (taskId: string, bins = 32): Promise<Heatmap> =>
    (await api.get<Heatmap>(`/tasks/${taskId}/stats/heatmap?bins=${bins}`)).data,
  timeOnTask: async (taskId: string): Promise<TimeOnTaskRow[]> =>
    (await api.get<TimeOnTaskRow[]>(`/tasks/${taskId}/stats/time-on-task`)).data,
  projectStats: async (projectId: string): Promise<ProjectStats> =>
    (await api.get<ProjectStats>(`/projects/${projectId}/stats`)).data,
};
