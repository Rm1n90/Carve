// Armin Mehri — mehri.armin@gmail.com
/**
 * v2.8 — ConfirmDialog primitive.
 *
 * Apple Liquid Glass alert/confirmation dialog built on Radix
 * AlertDialog. Replaces every `window.confirm()` callsite so the app
 * gets consistent, themeable confirmation UX (no Chrome-native popups).
 *
 * Two surfaces:
 *
 *   1. `<ConfirmDialog>` — controlled component for callers that already
 *      manage their own `open` state. Useful when the trigger lives next
 *      to the UI that needs the confirmation.
 *
 *   2. `<ConfirmProvider>` + `useConfirm()` — promise-based imperative
 *      API for migrating arbitrary `window.confirm()` callsites. Mount
 *      `<ConfirmProvider>` near the application root (alongside the
 *      existing Toaster) so any descendant route can call `confirm({…})`.
 *
 * The visuals pull from the v2.8 glass token set in `global.css`:
 *
 *   • `.glass-surface-strong` for the panel
 *   • `.glass-specular` for the simulated specular highlight
 *   • `.font-editorial` (Instrument Serif Italic) for the title
 *
 * Animation is wired via Radix's `data-state` selectors + CSS keyframes
 * so we don't pull framer-motion in for a single dialog.
 */
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";

export type ConfirmVariant = "default" | "danger";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
  onConfirm: () => void | Promise<void>;
}

// v3.1 Bug 1 — centering moved out of Tailwind classes to an inline
// `transform` style on the panel. Tailwind v4's `-translate-x-1/2
// -translate-y-1/2` writes the modern CSS `translate` property, which is
// independent of the `transform` property the `confirm-in/out` keyframes
// animate. The two stacked → panel offset by (-100%, -100%) during enter
// and snapped to (-50%, -50%) when the keyframe ended. Using
// `transform` here keeps the property name consistent with the keyframes.
const PANEL_STYLE = { transform: "translate(-50%, -50%)" } as const;

const PANEL_CLASSES = cn(
  // Position: centered (offset applied via PANEL_STYLE).
  "fixed left-1/2 top-1/2 z-[1100]",
  // Sizing.
  "w-[min(92vw,440px)] max-h-[88vh] overflow-hidden",
  // DESIGN.md §4 + §6 — alert dialogs are hero-tier surfaces. Solid
  // background, 24px radius, and the dramatic 0.8-shadow that genuinely
  // floats over the backdrop. No glass — DESIGN.md §1 reserves glass
  // for the Filter Mist sticky-bar moment only.
  "rounded-[var(--radius-24)]",
  "bg-[var(--bg-elev)] border border-[var(--border-subtle)]",
  "shadow-[var(--shadow-hero)]",
  // Layout & padding (28 28 24 per spec).
  "px-7 pt-7 pb-6",
  // Animation hooks — see @keyframes confirm-* below.
  "outline-none",
  "data-[state=open]:animate-confirm-in",
  "data-[state=closed]:animate-confirm-out",
);

const OVERLAY_CLASSES = cn(
  "fixed inset-0 z-[1099]",
  // Slightly stronger backdrop on dark; light theme readjusts via CSS var.
  "bg-[oklch(0_0_0/0.40)] backdrop-blur-sm",
  "data-[state=open]:animate-confirm-fade-in",
  "data-[state=closed]:animate-confirm-fade-out",
);

// DESIGN.md §4 — confirm/cancel buttons carry the same PlayStation hover
// signature as every other primary button: cyan fill swap, 2px white
// border, 2px PS-blue ring, 1.05× lift, 180ms ease.
const CONFIRM_BUTTON_CLASSES: Record<ConfirmVariant, string> = {
  default: cn(
    "bg-[var(--accent)] text-[color:var(--accent-fg)] border-[var(--accent)]",
    "hover:bg-[var(--accent-hover)] hover:border-white",
    "hover:shadow-[0_0_0_2px_var(--accent)] hover:scale-[1.05]",
    "active:opacity-60 active:scale-100",
  ),
  danger: cn(
    "bg-[var(--danger)] text-white border-[var(--danger)]",
    "hover:border-white hover:shadow-[0_0_0_2px_var(--danger)] hover:scale-[1.05]",
    "active:opacity-60 active:scale-100",
  ),
};

const BASE_BUTTON_CLASSES = cn(
  "inline-flex items-center justify-center",
  // DESIGN.md §4 + §5 — primary action pills are full 999px radius.
  "h-9 px-5 rounded-[var(--radius-pill)] border",
  "text-[13px] font-medium tracking-[0.4px] whitespace-nowrap select-none",
  "transition-all duration-[180ms] ease-out",
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
  "disabled:opacity-60 disabled:cursor-not-allowed",
);

const CANCEL_BUTTON_CLASSES = cn(
  "bg-transparent text-[color:var(--text-primary)] border-[var(--border-subtle)]",
  "hover:bg-[var(--bg-hover)] hover:border-[var(--border-strong)]",
);

/**
 * Controlled confirmation dialog. Use this directly when the caller
 * already owns the `open` state; for imperative callsites use the
 * `useConfirm()` hook instead.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "default",
  onConfirm,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);

  async function handleConfirm() {
    if (pending) return;
    try {
      setPending(true);
      await onConfirm();
      onOpenChange(false);
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className={OVERLAY_CLASSES} />
        <AlertDialogPrimitive.Content
          className={PANEL_CLASSES}
          style={PANEL_STYLE}
          data-variant={variant}
        >
          <AlertDialogPrimitive.Title
            className={cn(
              "font-editorial text-[24px] leading-[1.1] tracking-tight",
              "text-[color:var(--text-primary)]",
            )}
          >
            {title}
          </AlertDialogPrimitive.Title>
          {description !== undefined && description !== null && (
            <AlertDialogPrimitive.Description
              className={cn(
                "mt-2 text-[14px] leading-relaxed",
                "text-[color:var(--text-secondary)]",
              )}
            >
              {description}
            </AlertDialogPrimitive.Description>
          )}
          <div className="mt-6 flex items-center justify-end gap-2">
            <AlertDialogPrimitive.Cancel asChild>
              <button
                type="button"
                className={cn(BASE_BUTTON_CLASSES, CANCEL_BUTTON_CLASSES)}
                data-testid="confirm-dialog-cancel"
              >
                {cancelLabel}
              </button>
            </AlertDialogPrimitive.Cancel>
            <AlertDialogPrimitive.Action asChild>
              <button
                type="button"
                disabled={pending}
                onClick={(e) => {
                  // Prevent Radix from auto-closing before our async work
                  // resolves; we drive `open` ourselves via onConfirm.
                  e.preventDefault();
                  void handleConfirm();
                }}
                className={cn(
                  BASE_BUTTON_CLASSES,
                  CONFIRM_BUTTON_CLASSES[variant],
                )}
                data-testid="confirm-dialog-confirm"
                data-variant={variant}
              >
                {confirmLabel}
              </button>
            </AlertDialogPrimitive.Action>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}

// ----------------------------------------------------------------------
// Imperative API — `useConfirm()` returns a function that returns a
// promise. Replace `if (confirm("…")) doThing()` with:
//
//   const confirm = useConfirm();
//   if (await confirm({ title: "…" })) doThing();
//
// ----------------------------------------------------------------------

interface ConfirmRequest {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
}

type ConfirmFn = (request: ConfirmRequest) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface ProviderState extends ConfirmRequest {
  open: boolean;
}

const INITIAL_STATE: ProviderState = {
  open: false,
  title: "",
};

/**
 * Mount once near the application root. Provides the `useConfirm()` hook
 * to every descendant. Internally renders a single `ConfirmDialog` whose
 * state is driven by the latest imperative `confirm({…})` call.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ProviderState>(INITIAL_STATE);
  // We keep the resolver in a ref so re-renders don't break the in-flight
  // promise. Each call to `confirm()` allocates a fresh resolver and
  // replaces the previous one — the previous request resolves false so
  // a stale promise never leaks.
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((request) => {
    return new Promise<boolean>((resolve) => {
      // If something is already open, settle the previous request as
      // cancelled so its caller doesn't hang.
      if (resolverRef.current) {
        resolverRef.current(false);
      }
      resolverRef.current = resolve;
      setState({ ...request, open: true });
    });
  }, []);

  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) {
      // Closing without confirmation = cancelled.
      const resolver = resolverRef.current;
      resolverRef.current = null;
      setState((prev) => ({ ...prev, open: false }));
      if (resolver) resolver(false);
    } else {
      setState((prev) => ({ ...prev, open: true }));
    }
  }, []);

  const handleConfirm = useCallback(() => {
    const resolver = resolverRef.current;
    resolverRef.current = null;
    setState((prev) => ({ ...prev, open: false }));
    if (resolver) resolver(true);
  }, []);

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={state.open}
        onOpenChange={handleOpenChange}
        title={state.title}
        description={state.description}
        confirmLabel={state.confirmLabel}
        cancelLabel={state.cancelLabel}
        variant={state.variant}
        onConfirm={handleConfirm}
      />
    </ConfirmContext.Provider>
  );
}

/**
 * Returns a promise-based confirm() function. Throws if called outside
 * of `<ConfirmProvider>`. The returned function resolves `true` when
 * the user confirms and `false` for cancel/escape/backdrop-dismiss.
 */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error(
      "useConfirm must be used within a <ConfirmProvider>. " +
        "Mount <ConfirmProvider> near the application root.",
    );
  }
  return ctx;
}

/**
 * v3.7.2 — non-throwing variant of ``useConfirm``. Falls back to
 * ``window.confirm()`` when no ``<ConfirmProvider>`` is mounted (e.g.
 * legacy tests that render a component which wants to confirm but
 * didn't wrap with the provider). Production always has the provider
 * mounted in ``main.tsx``, so the fallback is a defensive guard
 * rather than a common path.
 */
export function useOptionalConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (ctx) return ctx;
  return (request) =>
    new Promise<boolean>((resolve) => {
      try {
        const ok = window.confirm(request.title);
        resolve(!!ok);
      } catch {
        // No window (SSR / non-DOM env) — default to "yes" to mirror
        // how the provider resolves when the user clicks confirm.
        resolve(true);
      }
    });
}
