// Armin Mehri — mehri.armin@gmail.com
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { forwardRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

interface DialogContentProps {
  children: ReactNode;
  className?: string;
  /** Close button hidden when false; default true. */
  showClose?: boolean;
}

/**
 * Dialog content. Mounts only while the parent <Dialog open> is true so the
 * native Radix open/close logic handles teardown (no `forceMount`).
 *
 * v3.0 — animation switched from framer-motion to CSS keyframes driven by
 * Radix's `data-state` attribute. Framer-motion's inline `transform` was
 * clobbering the Tailwind `-translate-x-1/2 -translate-y-1/2` centering
 * during the entrance animation, so the panel briefly appeared at the
 * top-left of viewport center until the animation completed and snapped
 * to true center. Reuses the `confirm-in/out` keyframes from `global.css`,
 * which apply `translate(-50%, -50%)` inside the keyframe so the panel
 * stays centered for the entire animation.
 */
export const DialogContent = forwardRef<HTMLDivElement, DialogContentProps>(
  function DialogContent({ children, className, showClose = true }, ref) {
    return (
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-[900] bg-[rgba(15,23,42,0.32)]",
            "data-[state=open]:animate-confirm-fade-in",
            "data-[state=closed]:animate-confirm-fade-out",
          )}
        />
        <DialogPrimitive.Content
          ref={ref}
          // v3.1 Bug 1 — centering uses the legacy `transform` property
          // (NOT Tailwind's `-translate-x-1/2 -translate-y-1/2`, which v4
          // implements via the modern `translate` CSS property). The
          // `confirm-in/out` keyframes also animate `transform`, so they
          // now agree and the panel stays centered for the entire
          // animation instead of snapping into place at the end.
          style={{ transform: "translate(-50%, -50%)" }}
          className={cn(
            "fixed left-1/2 top-1/2 z-[901]",
            "w-[min(92vw,520px)] max-h-[88vh] overflow-auto",
            "rounded-[var(--radius-lg)]",
            "glass-surface-strong glass-specular",
            "p-6",
            "outline-none",
            "data-[state=open]:animate-confirm-in",
            "data-[state=closed]:animate-confirm-out",
            className,
          )}
        >
          {children}
          {showClose && (
            <DialogPrimitive.Close
              className={cn(
                "absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center",
                "rounded-[var(--radius-sm)] text-[color:var(--text-tertiary)]",
                "hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
              )}
              aria-label="Close dialog"
            >
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    );
  },
);

export function DialogHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mb-4 grid gap-1", className)}>{children}</div>;
}

export function DialogTitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <DialogPrimitive.Title
      className={cn("text-[16px] font-medium tracking-tight text-[color:var(--text-primary)]", className)}
    >
      {children}
    </DialogPrimitive.Title>
  );
}

export function DialogDescription({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <DialogPrimitive.Description className={cn("text-[13px] text-[color:var(--text-secondary)]", className)}>
      {children}
    </DialogPrimitive.Description>
  );
}

export function DialogFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("mt-6 flex items-center justify-end gap-2", className)}>{children}</div>
  );
}
