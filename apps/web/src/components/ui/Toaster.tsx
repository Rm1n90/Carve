// Armin Mehri — mehri.armin@gmail.com
import * as ToastPrimitive from "@radix-ui/react-toast";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { subscribeToasts, type ToastEvent, type ToastVariant } from "@/lib/toast";
import { cn } from "@/lib/cn";

/**
 * Default auto-dismiss duration in milliseconds. Mirrors the fallback
 * baked into `lib/toast.ts` so a toast emitted without an explicit
 * `duration` still disappears on the same schedule as everything else.
 */
const DEFAULT_TOAST_DURATION_MS = 3500;

/**
 * Effectively-infinite duration passed to Radix's <Toast.Root> so its
 * built-in auto-close timer never fires. We own the timer ourselves
 * (see useEffect below) — Radix's timer otherwise pauses whenever the
 * viewport is hovered or the window loses focus, which is exactly
 * what caused some toasts in the bottom-right corner to "stick"
 * until the user dismissed them by hand.
 */
const RADIX_DURATION_DISABLED = 24 * 60 * 60 * 1000;

const VARIANT_ICON: Record<ToastVariant, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

// DESIGN.md §1 — solid surface; the left-edge accent stripe carries the
// semantic colour. Toasts are transient lifted UI, so they get the
// card-tier shadow rather than the dramatic hero shadow.
const VARIANT_CLASSES: Record<ToastVariant, string> = {
  info: "bg-[var(--bg-elev)] border border-[var(--border-subtle)] border-l-4 border-l-[var(--accent)] text-[color:var(--text-primary)]",
  success:
    "bg-[var(--bg-elev)] border border-[var(--border-subtle)] border-l-4 border-l-[var(--success)] text-[color:var(--text-primary)]",
  warning:
    "bg-[var(--bg-elev)] border border-[var(--border-subtle)] border-l-4 border-l-[var(--warning)] text-[color:var(--text-primary)]",
  error:
    "bg-[var(--bg-elev)] border border-[var(--border-subtle)] border-l-4 border-l-[var(--danger)] text-[color:var(--text-primary)]",
};

const VARIANT_ICON_COLOR: Record<ToastVariant, string> = {
  info: "text-[color:var(--text-tertiary)]",
  success: "text-[color:var(--success,#16a34a)]",
  warning: "text-[color:var(--warning,#f59e0b)]",
  error: "text-[color:var(--danger,#dc2626)]",
};

/**
 * Global Toast viewport. Subscribes to the toast bus (`@/lib/toast`) and
 * renders each emitted event via Radix Toast. Mount once near the top of the
 * tree (AppShell, editor pages) — multiple mounts are safe but redundant.
 *
 * See /tmp/v21-audit.md bug 1+I for the original silent-drop scenarios.
 */
export function Toaster() {
  const [toasts, setToasts] = useState<ToastEvent[]>([]);
  // Pending auto-dismiss timers, keyed by toast id, so manual close
  // (X button / Esc / swipe) cancels the timer instead of leaving it
  // dangling. Also lets the unmount cleanup tear them all down.
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  const dismiss = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    const unsub = subscribeToasts((evt) => {
      setToasts((prev) => [...prev, evt]);
      // Own the timer ourselves so the toast disappears on schedule
      // regardless of pointer-hover or window-focus state. Radix's
      // built-in duration pauses on hover/blur, which made toasts
      // emitted while the cursor lingered near the bottom-right
      // viewport stick around indefinitely.
      const ms = evt.duration ?? DEFAULT_TOAST_DURATION_MS;
      // Non-positive / non-finite duration → treat as default; never
      // honour a sentinel that would mean "never close".
      const safeMs = Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_TOAST_DURATION_MS;
      const timer = setTimeout(() => {
        timersRef.current.delete(evt.id);
        setToasts((prev) => prev.filter((t) => t.id !== evt.id));
      }, safeMs);
      timersRef.current.set(evt.id, timer);
    });
    return () => {
      unsub();
      for (const t of timersRef.current.values()) clearTimeout(t);
      timersRef.current.clear();
    };
  }, []);

  return (
    <ToastPrimitive.Provider swipeDirection="right">
      {toasts.map((t) => {
        const Icon = VARIANT_ICON[t.variant];
        return (
          <ToastPrimitive.Root
            key={t.id}
            // Radix's auto-close is disabled — our useEffect owns the
            // timer (see RADIX_DURATION_DISABLED comment up top). The
            // open-change handler still fires for the X button, Esc,
            // and swipe-to-dismiss; we route those through dismiss().
            duration={RADIX_DURATION_DISABLED}
            onOpenChange={(open) => {
              if (!open) dismiss(t.id);
            }}
            data-testid={`toast-${t.variant}`}
            className={cn(
              // DESIGN.md §5 / §6 — compact 6px radius, card-tier shadow.
              // Variant classes own the left-edge accent stripe.
              "rounded-[var(--radius-6)] shadow-[var(--shadow-card)]",
              "px-4 py-3 grid grid-cols-[auto_1fr_auto] gap-3 items-center",
              "min-w-[260px] max-w-[420px]",
              VARIANT_CLASSES[t.variant],
            )}
          >
            <Icon
              className={cn("h-4 w-4 shrink-0", VARIANT_ICON_COLOR[t.variant])}
              aria-hidden
            />
            <ToastPrimitive.Description className="text-[13px] tracking-tight">
              {t.message}
            </ToastPrimitive.Description>
            <ToastPrimitive.Close
              aria-label="Dismiss"
              className={cn(
                "grid h-6 w-6 place-items-center rounded-[var(--radius-sm)]",
                "text-[color:var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
              )}
            >
              <X className="h-3.5 w-3.5" />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        );
      })}
      <ToastPrimitive.Viewport
        data-testid="toast-viewport"
        className={cn(
          "fixed bottom-4 right-4 z-[1000] flex flex-col gap-2 outline-none",
          "max-h-screen w-fit",
        )}
      />
    </ToastPrimitive.Provider>
  );
}
