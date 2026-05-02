// Armin Mehri — mehri.armin@gmail.com
/**
 * Tiny module-level toast bus. Tools and other non-React contexts call
 * `showToast(...)`; the global `<Toaster />` (Radix Toast viewport) subscribes
 * via `subscribeToasts(...)` and renders the queue.
 *
 * Why a bus instead of a Zustand store? Toasts are ephemeral, fire-and-forget
 * UI events — we don't need state-derived rendering, and a tiny bus has zero
 * dependency on React state. Tests can subscribe directly without rendering.
 *
 * Created for /tmp/v21-audit.md bug 1+I — bbox/polygon/tag drawn without
 * an active class were silently dropped; the user sees nothing happen.
 */

export type ToastVariant = "info" | "success" | "warning" | "error";

export interface ToastEvent {
  id: string;
  message: string;
  variant: ToastVariant;
  /** ms to auto-dismiss; defaults to 3500. */
  duration?: number;
}

type Listener = (toast: ToastEvent) => void;

let nextId = 0;
const listeners = new Set<Listener>();

function makeId(): string {
  nextId += 1;
  return `toast-${Date.now()}-${nextId}`;
}

/**
 * Emit a toast. Safe to call from anywhere (canvas tools, mutations, effects).
 * Returns the generated event id so callers can correlate if needed.
 */
export function showToast(
  message: string,
  options?: { variant?: ToastVariant; duration?: number },
): string {
  const evt: ToastEvent = {
    id: makeId(),
    message,
    variant: options?.variant ?? "info",
    duration: options?.duration,
  };
  for (const l of listeners) {
    try {
      l(evt);
    } catch {
      // A misbehaving listener must not break the bus for others.
    }
  }
  return evt.id;
}

/** Subscribe to toast events. Returns an unsubscribe function. */
export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: clear all listeners between tests. */
export function _resetToastBusForTests(): void {
  listeners.clear();
}
