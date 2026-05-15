// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";

export interface JobRow {
  id: string;
  func: string;
  description: string | null;
  lane: string; // high | default | low
  state: string; // queued | running | failed
  enqueued_at: string | null;
  started_at: string | null;
  // Present only for batch jobs that wrote an aa:job:<id> progress hash.
  progress_status: string | null;
  done: number | null;
  total: number | null;
  created: number | null;
}

export interface JobsList {
  jobs: JobRow[];
}

export const jobsApi = {
  list: async (): Promise<JobsList> =>
    (await api.get<JobsList>("/jobs")).data,
  cancel: async (id: string): Promise<void> => {
    await api.post(`/jobs/${encodeURIComponent(id)}/cancel`);
  },
  reprioritize: async (id: string): Promise<{ result: string }> =>
    (
      await api.post<{ job_id: string; result: string }>(
        `/jobs/${encodeURIComponent(id)}/reprioritize`,
      )
    ).data,
};
