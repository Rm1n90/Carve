import * as DialogPrimitive from "@radix-ui/react-dialog";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { forwardRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const ANIM_OVERLAY = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.15 },
};
const ANIM_PANEL = {
  initial: { opacity: 0, scale: 0.98, y: 4 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.99, y: 2 },
  transition: { duration: 0.18, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] },
};

interface DialogContentProps {
  children: ReactNode;
  className?: string;
  /** Close button hidden when false; default true. */
  showClose?: boolean;
}

export const DialogContent = forwardRef<HTMLDivElement, DialogContentProps>(
  function DialogContent({ children, className, showClose = true }, ref) {
    return (
      <DialogPrimitive.Portal forceMount>
        <AnimatePresence>
          <DialogPrimitive.Overlay asChild forceMount>
            <motion.div
              {...ANIM_OVERLAY}
              className="fixed inset-0 z-[900] bg-[rgba(15,23,42,0.32)]"
            />
          </DialogPrimitive.Overlay>
          <DialogPrimitive.Content asChild forceMount>
            <motion.div
              ref={ref}
              {...ANIM_PANEL}
              className={cn(
                "fixed left-1/2 top-1/2 z-[901] -translate-x-1/2 -translate-y-1/2",
                "w-[min(92vw,520px)] max-h-[88vh] overflow-auto",
                "rounded-[var(--radius-lg)] border border-[var(--border-subtle)]",
                "bg-[var(--bg-elev)]",
                "shadow-[var(--shadow-elev-3)]",
                "p-6",
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
            </motion.div>
          </DialogPrimitive.Content>
        </AnimatePresence>
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
