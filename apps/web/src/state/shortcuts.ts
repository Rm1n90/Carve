// Armin Mehri -- mehri.armin@gmail.com
//
// Per-user shortcut state, hooks, and the global keydown helper.
//
// Data flow:
//   - useShortcutsQuery -- single query keyed ["shortcuts"], reads
//     /me/shortcuts. Default chord set lives in actions.ts; the query
//     only fetches the sparse override map.
//   - useShortcut(id) -- returns the resolved chord (override OR
//     default), reactively.
//   - useShortcutHandler(id, callback, options) -- adds a global
//     keydown listener that fires the callback when the resolved
//     chord matches. Empty-string overrides ("unbound") register the
//     listener but never fire.
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/auth/store";
import { shortcutsApi } from "@/api/shortcuts";
import { ACTIONS } from "@/lib/shortcuts/actions";
import { matchChord } from "@/lib/shortcuts/chord";

export const SHORTCUTS_QUERY_KEY = ["shortcuts"] as const;

// ----------------------------------------------------------------------
// Global capture-mode flag
//
// While the settings page is capturing a new chord we want every
// ``useShortcutHandler`` listener in the app to stay quiet so the
// captured keystroke doesn't accidentally trigger a real action (e.g.
// pressing ``c`` in the capture pad shouldn't also fire
// ``convert_to_bbox``). The settings page calls
// ``setShortcutCaptureActive(true)`` while the modal is open and
// resets it back to ``false`` on close. Plain module state -- no
// Zustand needed because every consumer reads it inside the listener
// callback, not inside React render.
// ----------------------------------------------------------------------
let captureActive = false;

/**
 * Set the global capture-mode flag. While ``true`` every listener
 * registered through ``useShortcutHandler`` becomes a no-op so the
 * settings capture pad has exclusive control of the keyboard.
 */
export function setShortcutCaptureActive(active: boolean): void {
  captureActive = active;
}

export function isShortcutCaptureActive(): boolean {
  return captureActive;
}

/**
 * Subscribe to the user's shortcut overrides. Auth-gated: only fetches
 * when an access token is present so anonymous routes (login, register)
 * don't 401 in the background.
 */
export function useShortcutsQuery() {
  const token = useAuth((s) => s.accessToken);
  return useQuery({
    queryKey: SHORTCUTS_QUERY_KEY,
    queryFn: shortcutsApi.get,
    enabled: !!token,
    // Overrides change rarely; rely on explicit invalidation from the
    // settings page rather than periodic refetches.
    staleTime: Infinity,
    refetchOnWindowFocus: true,
  });
}

/**
 * Resolve the chord for an action id. Falls back to the default when
 * the user has not overridden it.
 */
export function useShortcut(actionId: string): string {
  const q = useShortcutsQuery();
  const override = q.data?.overrides?.[actionId];
  if (typeof override === "string") return override;
  return ACTIONS[actionId]?.default ?? "";
}

/**
 * Convenience hook: register a global keydown listener that fires
 * ``callback`` when the user's resolved chord for ``actionId`` matches.
 *
 * Notes:
 *   - The handler reads the latest callback and chord through refs so
 *     the listener doesn't need to re-bind on every render.
 *   - Empty-chord overrides are treated as "unbound": the listener
 *     stays registered but never fires (forward compat for a future
 *     "disable shortcut" UI; not exposed in v1).
 *   - The input/textarea/contenteditable exemption lives inside
 *     ``matchChord``; chords that include ``mod`` may still fire while
 *     focused inside an editable element.
 */
export function useShortcutHandler(
  actionId: string,
  callback: (e: KeyboardEvent) => void,
  options?: { enabled?: boolean; capture?: boolean; preventDefault?: boolean },
): void {
  const enabled = options?.enabled ?? true;
  const capture = options?.capture ?? false;
  const preventDefault = options?.preventDefault ?? true;
  const chord = useShortcut(actionId);

  // Stable refs so the global listener doesn't need to re-bind when the
  // caller re-renders; matchChord is cheap so the chord ref + check
  // pattern keeps the hot path lock-free.
  const cbRef = useRef(callback);
  const chordRef = useRef(chord);
  cbRef.current = callback;
  chordRef.current = chord;

  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      // Capture pad in the settings page owns the keyboard while open.
      if (captureActive) return;
      const c = chordRef.current;
      if (!c) return; // unbound
      if (matchChord(e, c)) {
        if (preventDefault) e.preventDefault();
        cbRef.current(e);
      }
    }
    window.addEventListener("keydown", onKey, capture);
    return () => window.removeEventListener("keydown", onKey, capture);
  }, [enabled, capture, preventDefault]);
}
