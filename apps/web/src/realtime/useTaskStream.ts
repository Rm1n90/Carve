// Armin Mehri — mehri.armin@gmail.com
/**
 * React hook that owns the lifecycle of a :class:`RealtimeClient` for
 * the currently-active task.
 *
 * Phase 3 wiring:
 *
 *   * Mounts the client on first render with a non-null ``taskId``.
 *   * Unmounts / re-mounts on task switch (each task gets its own WS).
 *   * Calls ``stop()`` on unmount and resets the connection-status
 *     store so the next mount starts fresh.
 *
 * What this hook does *not* do (deferred):
 *
 *   * Phase 4 — callers pass ``onOps`` / ``onResync`` callbacks that
 *     update ``useAnnotations`` and invalidate react-query caches.
 *   * Phase 5/6 — separate ``usePresence`` hook will piggy-back on the
 *     same client instance.
 *   * Phase 7 — connection-status UI reads the Zustand store
 *     directly; no prop drilling.
 */

import { useEffect, useRef } from "react";

import { useConnectionStatus } from "@/realtime/connectionStatus";
import { RealtimeClient, type RealtimeCallbacks } from "@/realtime/ws";

export interface UseTaskStreamOptions extends RealtimeCallbacks {
  /** When ``null``, no connection is opened. Used by routes where
   *  the active task is loading or unset. */
  taskId: string | null;
}

/**
 * Mount a RealtimeClient against ``taskId``. Returns the live
 * client instance so callers can ``send()`` outbound presence frames
 * (Phase 5). Returns ``null`` while ``taskId`` is unset.
 *
 * The hook is intentionally minimal — the heavy lifting lives in
 * :class:`RealtimeClient`. We only manage the mount-edge here.
 */
export function useTaskStream(
  options: UseTaskStreamOptions,
): RealtimeClient | null {
  const clientRef = useRef<RealtimeClient | null>(null);
  // Latest callbacks — captured in a ref so we don't tear down the
  // client every time the parent re-renders with a new closure.
  const callbacksRef = useRef<RealtimeCallbacks>({
    onHello: options.onHello,
    onOps: options.onOps,
    onResync: options.onResync,
    onError: options.onError,
    onUnknown: options.onUnknown,
    onPresence: options.onPresence,
  });
  callbacksRef.current = {
    onHello: options.onHello,
    onOps: options.onOps,
    onResync: options.onResync,
    onError: options.onError,
    onUnknown: options.onUnknown,
    onPresence: options.onPresence,
  };

  useEffect(() => {
    if (!options.taskId) {
      return;
    }
    // Reset before mount so a stale watermark from a prior task
    // doesn't leak into the new task's ``?last_event_seq=``.
    useConnectionStatus.getState().reset();
    const client = new RealtimeClient({
      taskId: options.taskId,
      // Dispatch through the ref so callback identity changes don't
      // remount the client — we want the WS to live across renders.
      onHello: (msg) => callbacksRef.current.onHello?.(msg),
      onOps: (msg) => callbacksRef.current.onOps?.(msg),
      onResync: (msg) => callbacksRef.current.onResync?.(msg),
      onError: (msg) => callbacksRef.current.onError?.(msg),
      onUnknown: (msg) => callbacksRef.current.onUnknown?.(msg),
      onPresence: (msg) => callbacksRef.current.onPresence?.(msg),
    });
    clientRef.current = client;
    void client.start();
    return () => {
      client.stop();
      if (clientRef.current === client) {
        clientRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.taskId]);

  return clientRef.current;
}
