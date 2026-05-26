// Armin Mehri — mehri.armin@gmail.com
/**
 * useTaskResume — per-user task resume status. Fetches once on mount of
 * the editor and drives <ResumeProgressBanner />. ``staleTime: 0`` +
 * ``refetchOnMount: "always"`` because each task page mount is a fresh
 * "did I work here before" question — never serve cached banner state.
 */
import { useQuery } from "@tanstack/react-query";

import { tasksApi, type TaskResumeStatusResponse } from "../api/tasks";

export function useTaskResume(
  projectId: string | undefined,
  taskId: string | undefined,
) {
  return useQuery<TaskResumeStatusResponse>({
    queryKey: ["task-resume", projectId, taskId],
    queryFn: () => tasksApi.resumeStatus(projectId!, taskId!),
    enabled: Boolean(projectId) && Boolean(taskId),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
}
