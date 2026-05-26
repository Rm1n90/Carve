// Armin Mehri — mehri.armin@gmail.com
/**
 * Thin REST wrapper for the realtime endpoints.
 *
 * Phase 3 only ships :func:`fetchRealtimeTicket`. Phase 4 will add
 * any axios-level wiring for the ``X-Origin-Session`` header.
 */

import { api } from "@/api/client";

export interface RealtimeTicket {
  ticket: string;
  expires_in: number;
}

/**
 * Mint a one-time WebSocket ticket for the given task.
 *
 * The ticket is single-use (server consumes via GETDEL), bound to
 * ``(user_id, task_id)``, and expires after 30 s. Always fetch a fresh
 * ticket immediately before opening (or reopening) the socket — do not
 * cache.
 */
export async function fetchRealtimeTicket(
  taskId: string,
): Promise<RealtimeTicket> {
  const response = await api.post<RealtimeTicket>("/realtime/ticket", {
    task_id: taskId,
  });
  return response.data;
}
