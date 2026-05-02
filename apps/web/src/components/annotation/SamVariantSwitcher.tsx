/**
 * v3.5 Phase B — shared SAM variant switcher.
 *
 * Both the editor toolbar's compact picker and the settings page's
 * full radio group are rendered by this component. The runtime hot-swap
 * endpoint (POST /models/sam-active) is wired up identically in both
 * variants so the editor picker actually works (audit Issue 3 fix).
 *
 * Variants:
 *   - "full"    — settings page: radio group + descriptions + active card
 *   - "compact" — editor toolbar popover content: list rows with badge
 *
 * Both share:
 *   - confirm dialog ("Switch to <variant>?")
 *   - loading spinner (mutation pending — typical 5-30s)
 *   - success/error toast
 *   - react-query invalidation of ["sam-active"]
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Layers, Sparkles } from "lucide-react";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { modelsApi } from "@/api/phase2";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { ModelLoadingOverlay } from "./ModelLoadingOverlay";

const SAM_VARIANT_LABEL: Record<string, string> = {
  "sam2.1-tiny": "SAM 2.1 — Tiny (39MB · fastest)",
  "sam2.1-small": "SAM 2.1 — Small",
  "sam2.1-base+": "SAM 2.1 — Base+",
  "sam2.1-large": "SAM 2.1 — Large (slowest · best)",
  sam3: "SAM 3 — concept-driven prompting",
  "sam3.1": "SAM 3.1 — multi-object multiplex tracker",
};

const COMPACT_VARIANT_NOTES: Record<string, string> = {
  "sam2.1-tiny": "Tiny — fastest",
  "sam2.1-small": "Small — balanced",
  "sam2.1-base+": "Base+ — accurate",
  "sam2.1-large": "Large — best quality",
  sam3: "SAM 3 — preview",
  "sam3.1": "SAM 3.1 — multiplex (recommended)",
};

export interface SamVariantSwitcherProps {
  /** "compact" → editor toolbar popover; "full" → settings page card. */
  variant?: "compact" | "full";
  /** Fired after a successful switch. */
  onVariantChange?: (variant: string) => void;
}

export function SamVariantSwitcher({
  variant = "full",
  onVariantChange,
}: SamVariantSwitcherProps) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const samQ = useQuery({
    queryKey: ["sam-active"],
    queryFn: () => modelsApi.samActive(),
  });
  const data = samQ.data;
  const active = data?.active;
  const available = data?.available ?? [];

  // Track in-flight switch so we can disable interactions and surface a
  // spinner with the pending variant label. The mutation also exposes
  // ``isPending`` but we keep a separate ``pendingVariant`` so the live
  // region copy can name the variant currently loading.
  const [pendingVariant, setPendingVariant] = useState<string | null>(null);

  // v3.5 Phase C — overlay state moved up here so onMutate can open it
  // immediately (before the 202 response comes back) and onSuccess can
  // keep it open for status polling.
  const [overlayOpen, setOverlayOpen] = useState(false);

  const switchM = useMutation({
    mutationFn: (next: string) => modelsApi.samSetActive(next),
    onMutate: (next) => {
      setPendingVariant(next);
      setOverlayOpen(true);
    },
    onSuccess: (result) => {
      // 202 — the load is now happening in the background. The overlay
      // (polling /models/sam-status) will close itself when state→ready.
      // The toast fires here so users see immediate feedback that the
      // switch was accepted.
      showToast(`Switching to ${result.active_variant}…`, {
        variant: "success",
      });
      void qc.invalidateQueries({ queryKey: ["sam-active"] });
      onVariantChange?.(result.active_variant);
    },
    onError: () => {
      showToast("Failed to switch SAM variant", { variant: "error" });
      setOverlayOpen(false);
    },
    onSettled: () => {
      setPendingVariant(null);
    },
  });

  const switching = switchM.isPending;

  // "Unreachable" mirrors the prior editor toolbar logic: either the
  // query errored, the available list is empty after a fetch, or the
  // API explicitly returned reachable=false.
  const unreachable =
    !!samQ.error ||
    (samQ.isFetched && available.length === 0) ||
    (samQ.isFetched && data?.reachable === false);

  async function handleVariantChange(next: string): Promise<void> {
    if (switching) return;
    if (next === active) return;
    const ok = await confirm({
      title: `Switch to ${SAM_VARIANT_LABEL[next] ?? next}?`,
      description:
        "The current model will be offloaded from GPU memory. Loading the new variant takes 5-30 seconds.",
      confirmLabel: "Switch",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    switchM.mutate(next);
  }

  // v3.5 Phase C — full-screen progress overlay while the variant is
  // switching. The overlay polls /models/sam-status itself and dismisses
  // automatically when the load finishes (state→ready or error). The
  // mutation's onMutate opens it (synchronous w/ user click); onError
  // closes it. ``overlayOpen`` lives at the top of the component (above
  // the mutation declaration) so onMutate can flip it immediately.
  const overlayHint = pendingVariant ?? undefined;

  const overlay = (
    <ModelLoadingOverlay
      open={overlayOpen}
      onClose={() => setOverlayOpen(false)}
      onError={(detail) => {
        if (detail && detail !== "model_load_failed") {
          showToast(`SAM load failed: ${detail}`, { variant: "error" });
        }
      }}
      variantHint={overlayHint}
    />
  );

  if (variant === "compact") {
    return (
      <div data-testid="sam-variant-switcher-compact">
        {overlay}
        <p className="px-2 py-1.5 text-[10.5px] uppercase tracking-[0.10em] text-[color:var(--text-tertiary)]">
          SAM model
        </p>
        {unreachable && (
          <div
            data-testid="sam-picker-unreachable-banner"
            className="mx-1 mb-1 px-2 py-2 text-[11.5px] rounded-[var(--radius-xs)] bg-[var(--bg-subtle)] text-[color:var(--text-secondary)] flex items-start gap-1.5"
          >
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 text-[color:var(--danger)] shrink-0" />
            <span>
              Model service is not running. Start it with
              <code className="mx-1 px-1 py-0.5 rounded bg-[var(--bg-app)] text-[10.5px] font-mono">
                docker compose --profile inference up -d
              </code>
              .
            </span>
          </div>
        )}
        {samQ.isLoading && !unreachable ? (
          <p className="px-2 py-2 text-[12px] text-[color:var(--text-tertiary)] italic">
            Loading…
          </p>
        ) : (
          available.map((name) => {
            const isActive = name === active;
            const isPending = name === pendingVariant;
            return (
              <button
                key={name}
                type="button"
                role="listitem"
                onClick={() => {
                  void handleVariantChange(name);
                }}
                disabled={switching}
                aria-label={`${name}${isActive ? " (active)" : ""}`}
                data-testid={`sam-variant-${name}`}
                data-active={isActive ? "true" : undefined}
                className={cn(
                  "w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)]",
                  "text-[12.5px] tracking-tight outline-none text-left",
                  "disabled:cursor-not-allowed",
                  isActive ? "bg-[var(--accent-bg)]" : "hover:bg-[var(--bg-hover)]",
                )}
              >
                {isPending ? (
                  <span
                    aria-hidden
                    data-testid={`sam-variant-spinner-${name}`}
                    className="inline-block h-3.5 w-3.5 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin"
                  />
                ) : isActive ? (
                  <Check className="h-3.5 w-3.5 text-[color:var(--accent)]" />
                ) : (
                  <span className="h-3.5 w-3.5" aria-hidden />
                )}
                <span className="flex-1">{name}</span>
                <span className="text-[10.5px] text-[color:var(--text-tertiary)]">
                  {COMPACT_VARIANT_NOTES[name] ?? ""}
                </span>
                {isActive && !isPending && (
                  <span className="text-[9.5px] uppercase tracking-[0.10em] px-1.5 py-0.5 rounded bg-[var(--accent)] text-[color:var(--accent-fg)] font-medium">
                    active
                  </span>
                )}
              </button>
            );
          })
        )}
        {switching && (
          <p
            role="status"
            aria-live="polite"
            data-testid="sam-switching-status"
            className="px-2 py-2 mt-1 border-t border-[var(--border-subtle)] text-[11px] text-[color:var(--text-tertiary)] leading-snug"
          >
            Loading {SAM_VARIANT_LABEL[pendingVariant ?? ""] ?? pendingVariant}…
            this can take 30 seconds.
          </p>
        )}
      </div>
    );
  }

  // ------------------------------ "full" ------------------------------
  return (
    <div className="grid gap-6" data-testid="sam-variant-switcher-full">
      {overlay}
      <Card variant="surface" radius="lg" className="p-6 grid gap-4">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-[var(--radius-md)] bg-[var(--accent-bg)] text-[color:var(--accent)]">
            <Sparkles className="h-5 w-5" />
          </span>
          <div>
            <p className="text-[12px] tracking-tight text-[color:var(--text-tertiary)] uppercase">
              Active variant
            </p>
            <p
              className="text-[18px] font-medium tracking-tight"
              data-testid="sam-active-variant-label"
            >
              {samQ.isLoading
                ? "…"
                : SAM_VARIANT_LABEL[active ?? ""] ?? active}
            </p>
          </div>
        </div>
      </Card>

      <Card variant="surface" radius="lg" className="overflow-hidden">
        <div className="px-6 py-4 border-b border-[var(--border-subtle)]">
          <h2 className="text-[14px] font-medium tracking-tight">
            Available variants
          </h2>
          <p className="text-[12px] text-[color:var(--text-tertiary)] mt-0.5">
            Select a variant to hot-swap the active SAM model. The model
            service offloads the current model and loads the new one
            (typically 5-30 seconds).
          </p>
        </div>
        <ul
          role="radiogroup"
          aria-label="sam-variant"
          aria-busy={switching}
          data-testid="sam-variant-radiogroup"
        >
          {available.map((name) => {
            const isActive = name === active;
            const id = `sam-variant-${name}`;
            return (
              <li
                key={name}
                className={cn(
                  "px-6 py-3 border-b border-[var(--border-subtle)] last:border-b-0 flex items-center gap-3",
                  isActive ? "bg-[var(--accent-bg)]" : "",
                )}
              >
                <input
                  type="radio"
                  id={id}
                  name="sam-variant"
                  value={name}
                  checked={isActive}
                  disabled={switching}
                  onChange={() => {
                    void handleVariantChange(name);
                  }}
                  className="h-4 w-4 accent-[var(--accent)] cursor-pointer disabled:cursor-not-allowed"
                  data-testid={`sam-variant-radio-${name}`}
                  aria-label={SAM_VARIANT_LABEL[name] ?? name}
                />
                <Layers
                  className={cn(
                    "h-3.5 w-3.5",
                    isActive
                      ? "text-[color:var(--accent)]"
                      : "text-[color:var(--text-tertiary)]",
                  )}
                />
                <label
                  htmlFor={id}
                  className={cn(
                    "text-[13.5px] tracking-tight",
                    switching ? "" : "cursor-pointer",
                  )}
                >
                  {SAM_VARIANT_LABEL[name] ?? name}
                </label>
                {isActive && !switching && (
                  <Badge variant="accent" className="ml-auto">
                    Active
                  </Badge>
                )}
              </li>
            );
          })}
        </ul>
        {switching && (
          <div
            className="px-6 py-3 border-t border-[var(--border-subtle)] flex items-center gap-3 bg-[var(--bg-subtle)]"
            role="status"
            aria-live="polite"
            data-testid="sam-switching-status"
          >
            <span
              className="inline-block h-3.5 w-3.5 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin"
              aria-hidden="true"
            />
            <span className="text-[12.5px] text-[color:var(--text-secondary)]">
              Loading {SAM_VARIANT_LABEL[pendingVariant ?? ""] ?? pendingVariant}
              … this can take 30 seconds.
            </span>
          </div>
        )}
      </Card>
    </div>
  );
}
