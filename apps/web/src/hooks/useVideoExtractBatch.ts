// Armin Mehri — mehri.armin@gmail.com
import { useQuery } from "@tanstack/react-query";

import { videoExtractApi, type BatchEnvelope } from "../api/video_extract";

/**
 * Drives the video-extract progress dialog. 2s polling that pauses
 * once every job in the batch reaches a terminal state, so an
 * abandoned dialog doesn't keep hammering the API.
 */
export function useVideoExtractBatch(
  projectId: string | undefined,
  taskId: string | undefined,
  batchId: string | undefined,
) {
  return useQuery<BatchEnvelope>({
    queryKey: ["video-extract-batch", projectId, taskId, batchId] as const,
    queryFn: () =>
      videoExtractApi.getBatchStatus(projectId!, taskId!, batchId!),
    enabled: Boolean(projectId) && Boolean(taskId) && Boolean(batchId),
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data) return 2000;
      const allTerminal = data.jobs.every((j) =>
        ["succeeded", "failed", "cancelled"].includes(j.status),
      );
      return allTerminal ? false : 2000;
    },
    refetchOnWindowFocus: false,
  });
}
