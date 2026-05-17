// Armin Mehri — mehri.armin@gmail.com
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
import { projectsApi } from "@/api/projects";
import { useBackgroundJobs } from "@/state/backgroundJobs";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { ModelLoadingOverlay } from "./ModelLoadingOverlay";

const SAM_VARIANT_LABEL: Record<string, string> = {
  "sam2.1-tiny": "SAM 2.1 — Tiny (39MB · fastest)",
  "sam2.1-small": "SAM 2.1 — Small",
  "sam2.1-base+": "SAM 2.1 — Base+",
  "sam2.1-large": "SAM 2.1 — Large (slowest · best)",
  "sam3.1": "SAM 3.1 — concept + multiplex (text/box/visual)",
};

const COMPACT_VARIANT_NOTES: Record<string, string> = {
  "sam2.1-tiny": "Tiny — fastest",
  "sam2.1-small": "Small — balanced",
  "sam2.1-base+": "Base+ — accurate",
  "sam2.1-large": "Large — best quality",
  "sam3.1": "SAM 3.1 — concept-driven (recommended)",
};

export interface SamVariantSwitcherProps {
  /** "compact" → editor toolbar popover; "full" → settings page card. */
  variant?: "compact" | "full";
  /** Fired after a successful switch. */
  onVariantChange?: (variant: string) => void;
  /**
   * v3.32 — when set, a successful switch also PATCHes the project's
   * ``default_sam_variant`` so the choice persists across API restarts
   * and idle eviction. Caller (the editor toolbar) is responsible for
   * passing the active project id; the workspace SAM page leaves this
   * undefined and the switch stays runtime-only.
   */
  projectId?: string;
  /**
   * v3.32 — gate for the project-persistence side-effect. Only callers
   * that have verified the current user is owner / workspace admin
   * should set this true. When false (default), the switch happens
   * runtime-only and the project record is untouched. Backend enforces
   * the same gate (PATCH /projects/{id} returns 403 for non-admins) so
   * a misset flag is safe-fail, not destructive.
   */
  canPersistProjectDefault?: boolean;
}

export function SamVariantSwitcher({
  variant = "full",
  onVariantChange,
  projectId,
  canPersistProjectDefault = false,
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
  // The ready/error toast + ``carve:sam-variant-ready`` event are
  // emitted by ``SamSwitchWatcher`` (mounted in AppShell/AppShellBleed)
  // so they survive this component being unmounted — the compact
  // switcher lives inside a popover that closes the moment the user
  // clicks outside it. ``onMutate`` below still dispatches
  // ``carve:sam-variant-switching`` so the watcher knows to start
  // polling.

  const switchM = useMutation({
    mutationFn: ({
      variant: next,
      force,
    }: {
      variant: string;
      force?: boolean;
    }) =>
      // Preserve the legacy single-arg call signature when there's no
      // force flag in play. Tests assert on the exact arguments list;
      // omitting the unused option object keeps them passing without
      // weakening the assertions.
      force
        ? modelsApi.samSetActive(next, { force: true })
        : modelsApi.samSetActive(next),
    onMutate: ({ variant: next }) => {
      setPendingVariant(next);
      setOverlayOpen(true);
      // Broadcast switch-start. The canvas listens to invalidate the
      // SamTool encoding cache (the old image hash is tied to the
      // previous variant). ``SamSwitchWatcher`` in AppShell listens
      // to start its own ready/error background poll — surviving any
      // unmount of this popover-hosted component.
      window.dispatchEvent(
        new CustomEvent("carve:sam-variant-switching", {
          detail: { variant: next },
        }),
      );
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
      // v3.32 — persist the user's choice on the project record so it
      // survives API restarts and idle eviction. Gated to callers that
      // explicitly opted in (editor toolbar passes ``canPersist=true``
      // only when the current user is owner/admin); backend re-checks
      // the role, so a misset flag is safe-fail (403 toast).
      if (projectId && canPersistProjectDefault) {
        projectsApi
          .update(projectId, { default_sam_variant: result.active_variant })
          .then(() => {
            void qc.invalidateQueries({ queryKey: ["project", projectId] });
          })
          .catch((err: unknown) => {
            // Roll forward — the runtime switch already succeeded, only
            // the persist failed. Surface a soft warning so the user
            // knows their preference wasn't saved.
            const status =
              (err as { response?: { status?: number } } | undefined)
                ?.response?.status ?? 0;
            if (status === 403) {
              showToast(
                "SAM switched, but only project owner or admin can save"
                  + " this as the project default.",
                { variant: "warning", duration: 5000 },
              );
            } else {
              showToast(
                "SAM switched, but couldn't save it as the project default."
                  + " Try again from project settings.",
                { variant: "warning", duration: 5000 },
              );
            }
          });
      }
      onVariantChange?.(result.active_variant);
    },
    onError: async (
      err: unknown,
      variables: { variant: string; force?: boolean },
    ) => {
      setOverlayOpen(false);
      // v3.32 -- inspect the backend response for the structured
      // active-batch block. The router returns 409 + detail:
      // {error, code, active_jobs:[], can_force:boolean, message}.
      // For admins we offer a "Force switch" follow-up; non-admins
      // see the explanation and a count.
      const apiErr = err as {
        response?: {
          status?: number;
          data?: {
            detail?:
              | string
              | {
                  code?: string;
                  error?: string;
                  active_jobs?: Array<{
                    job_id: string;
                    status: string;
                    done?: number;
                    total?: number;
                  }>;
                  can_force?: boolean;
                  message?: string;
                };
          };
        };
      };
      const status = apiErr?.response?.status;
      const detail = apiErr?.response?.data?.detail;
      const code =
        typeof detail === "object" && detail !== null
          ? detail.code ?? detail.error
          : undefined;
      if (status === 409 && code === "switch_blocked_by_active_jobs"
          && typeof detail === "object" && detail !== null) {
        const jobs = detail.active_jobs ?? [];
        const canForce = Boolean(detail.can_force);
        // Read the variant from the mutation's variables so we don't
        // depend on React state closure timing — onError fires after
        // ``setPendingVariant(null)`` may have already landed.
        const variantBeingLoaded = variables.variant;
        // Always close out the pending UI state -- the original
        // request didn't go through.
        setPendingVariant(null);
        if (canForce && variantBeingLoaded) {
          // Re-confirm with an explicit destructive warning. The user
          // sees the affected jobs by count + progress.
          const summary = jobs
            .map((j) => `• ${j.done ?? 0}/${j.total ?? "?"} (${j.status})`)
            .join("\n");
          const ok = await confirm({
            title: `Force switch to ${variantBeingLoaded}?`,
            description:
              `${jobs.length} batch job(s) are currently running:\n\n` +
              `${summary}\n\nForcing the switch will cancel them.`,
            confirmLabel: `Force switch (cancel ${jobs.length})`,
            cancelLabel: "Keep current model",
          });
          if (ok) {
            switchM.mutate({ variant: variantBeingLoaded, force: true });
          }
          return;
        }
        showToast(
          detail.message ??
            `Can't switch SAM: ${jobs.length} batch job(s) are running.`,
          { variant: "error", duration: 7000 },
        );
        return;
      }
      showToast("Failed to switch SAM variant", { variant: "error" });
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

    // v3.32 -- read the same-user active jobs from the background-jobs
    // store. Anything that talks to SAM (auto-text, auto-visual, sam
    // refine, polygon convert that calls SAM) is a switch hazard;
    // YOLO predict batches don't touch SAM so they're excluded.
    const samAffectingKinds = new Set([
      "sam-auto-text",
      "sam-auto-visual",
      "sam-refine-batch",
      "polygon-convert",
    ]);
    const sameUserJobs = Object.values(useBackgroundJobs.getState().jobs)
      .filter((j) => samAffectingKinds.has(j.kind));

    let ok: boolean;
    if (sameUserJobs.length > 0) {
      // Stronger warning when the user has their own SAM batch in
      // flight. Default is Cancel; the user has to explicitly opt in
      // to "Switch anyway".
      const labelLines = sameUserJobs
        .map((j) => {
          const p = j.progress;
          const fraction = p && p.total
            ? ` (${p.done ?? 0}/${p.total})`
            : "";
          return `• ${j.label}${fraction}`;
        })
        .join("\n");
      ok = await confirm({
        title: `Switch to ${SAM_VARIANT_LABEL[next] ?? next}?`,
        description:
          `You have ${sameUserJobs.length} running batch job(s) that use SAM:\n\n` +
          `${labelLines}\n\n` +
          "Switching now will likely cause them to skip the remaining " +
          "assets. Consider waiting until they finish.",
        confirmLabel: "Switch anyway",
        cancelLabel: "Keep current",
        variant: "danger",
      });
    } else {
      ok = await confirm({
        title: `Switch to ${SAM_VARIANT_LABEL[next] ?? next}?`,
        description:
          "The current model will be offloaded from GPU memory. Loading the new variant takes 5-30 seconds.",
        confirmLabel: "Switch",
        cancelLabel: "Cancel",
      });
    }
    if (!ok) return;
    // Admin force-switch only kicks in via the backend 409 path; the
    // onError handler reads ``detail.can_force`` from the response
    // and presents the destructive follow-up confirm if applicable.
    switchM.mutate({ variant: next });
  }

  // v3.5 Phase C — full-screen progress overlay while the variant is
  // switching. The overlay polls /models/sam-status itself and dismisses
  // automatically when the load finishes (state→ready or error). The
  // mutation's onMutate opens it (synchronous w/ user click); onError
  // closes it. ``overlayOpen`` lives at the top of the component (above
  // the mutation declaration) so onMutate can flip it immediately.
  const overlayHint = pendingVariant ?? undefined;

  // The overlay is a pure visual indicator now — the ready/error
  // notifications (toast + carve:sam-variant-ready event) come from
  // the background ``statusPollQ`` effect above so they fire even when
  // the user dismisses the overlay with "Continue without waiting".
  const overlay = (
    <ModelLoadingOverlay
      open={overlayOpen}
      onClose={() => setOverlayOpen(false)}
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
              className="text-[18px] font-light tracking-tight"
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
