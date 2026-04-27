import * as ToastPrimitive from "@radix-ui/react-toast";
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { subscribeToasts, type ToastEvent, type ToastVariant } from "@/lib/toast";
import { cn } from "@/lib/cn";

const VARIANT_ICON: Record<ToastVariant, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

const VARIANT_CLASSES: Record<ToastVariant, string> = {
  info: "border-[var(--border-strong)] bg-[var(--bg-elev)] text-[color:var(--text-primary)]",
  success:
    "border-[var(--success,#16a34a)] bg-[var(--bg-elev)] text-[color:var(--text-primary)]",
  warning:
    "border-[var(--warning,#f59e0b)] bg-[var(--bg-elev)] text-[color:var(--text-primary)]",
  error:
    "border-[var(--danger,#dc2626)] bg-[var(--bg-elev)] text-[color:var(--text-primary)]",
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

  useEffect(() => {
    return subscribeToasts((evt) => {
      setToasts((prev) => [...prev, evt]);
    });
  }, []);

  function dismiss(id: string) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  return (
    <ToastPrimitive.Provider swipeDirection="right">
      {toasts.map((t) => {
        const Icon = VARIANT_ICON[t.variant];
        return (
          <ToastPrimitive.Root
            key={t.id}
            duration={t.duration ?? 3500}
            onOpenChange={(open) => {
              if (!open) dismiss(t.id);
            }}
            data-testid={`toast-${t.variant}`}
            className={cn(
              "rounded-[var(--radius-md)] border-l-4 shadow-[var(--shadow-elev-2)]",
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
