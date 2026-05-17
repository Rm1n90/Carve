// Armin Mehri — mehri.armin@gmail.com
/**
 * useProjectSamReconcile — bridges the project's persisted preferred
 * SAM variant (``projects.default_sam_variant``) with the variant the
 * model service actually has loaded.
 *
 * The user reported that the editor sometimes shows ``sam2.1-tiny``
 * even after they picked ``sam3.1`` on the SAM page. Root cause: after
 * an API restart or idle eviction the in-memory ``_active_sam_variant``
 * is wiped and the GET endpoint falls back to ``settings.sam_model``
 * (env default). The v3.32 fix surfaces the project's preference via
 * ``preferred_variant`` / ``preferred_loaded`` so the editor can ask
 * "Load <variant> for this project?" and reconcile the two.
 *
 * Behaviour:
 *   • Polls ``samActive(projectId)`` once per editor mount (TanStack
 *     Query handles caching; this hook only triggers the dialog).
 *   • When ``preferred_variant`` exists, ``preferred_loaded === false``,
 *     AND the user hasn't already been asked this session, opens a
 *     confirm dialog.
 *   • On confirm → fires ``samSetActive(preferred_variant)``. The
 *     existing ``SamSwitchWatcher`` (mounted at AppShell) handles the
 *     post-switch toast and "ready" event.
 *   • On cancel → records a per-session dismiss so the user isn't
 *     re-prompted on every focus / re-render.
 *
 * The hook is intentionally permissionless: any project member can be
 * asked. (Only OWNER/ADMIN can *persist* a new project default — that
 * gate lives at the API layer in ProjectPatch.) "Load this variant
 * now" is just a runtime switch, not a write to the project record.
 */
import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { modelsApi } from "@/api/phase2";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { showToast } from "@/lib/toast";

/**
 * Per-projectId record of "already asked this session" so a user who
 * dismissed the prompt doesn't get re-asked on tab focus / asset
 * navigation. Lives at module scope (not state) because we want it
 * to survive component re-mounts — the user dismissing once should
 * stick until the page is reloaded.
 */
const _DISMISSED_FOR_PROJECT = new Set<string>();

export function useProjectSamReconcile(projectId: string | undefined): void {
  const confirm = useConfirm();
  const qc = useQueryClient();
  // Guards against double-prompting when React StrictMode re-runs
  // effects in development. The set above handles cross-mount dismiss;
  // this ref handles same-mount race.
  const promptInFlightRef = useRef(false);

  const samQ = useQuery({
    queryKey: ["sam-active", projectId ?? null],
    queryFn: () => modelsApi.samActive(projectId),
    enabled: Boolean(projectId),
    // 30s is enough that the editor doesn't refetch on every
    // micro-interaction; long enough that a fresh switch is reflected
    // within a reasonable window.
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const switchM = useMutation({
    mutationFn: (variant: string) => modelsApi.samSetActive(variant),
    onMutate: (variant) => {
      window.dispatchEvent(
        new CustomEvent("carve:sam-variant-switching", {
          detail: { variant },
        }),
      );
    },
    onSuccess: (result) => {
      showToast(`Loading ${result.active_variant} for this project…`, {
        variant: "info",
      });
      void qc.invalidateQueries({ queryKey: ["sam-active"] });
    },
    onError: () => {
      showToast("Couldn't load the project's preferred SAM variant.", {
        variant: "error",
      });
    },
  });

  useEffect(() => {
    const data = samQ.data;
    if (!projectId) return;
    if (!data) return;
    if (promptInFlightRef.current) return;
    if (_DISMISSED_FOR_PROJECT.has(projectId)) return;

    const preferred = data.preferred_variant ?? null;
    const loaded = data.preferred_loaded ?? true;
    if (!preferred) return;
    if (loaded) return;

    promptInFlightRef.current = true;
    void (async () => {
      try {
        const ok = await confirm({
          title: `Load ${preferred} for this project?`,
          description:
            `This project's preferred SAM variant is ${preferred}, but ` +
            `${data.active} is currently loaded. Loading takes ` +
            "5–30 seconds — the editor stays usable in the meantime.",
          confirmLabel: `Load ${preferred}`,
          cancelLabel: "Keep current",
        });
        if (ok) {
          switchM.mutate(preferred);
        } else {
          // Honour the dismissal for this project's session lifetime.
          _DISMISSED_FOR_PROJECT.add(projectId);
        }
      } finally {
        promptInFlightRef.current = false;
      }
    })();
    // We intentionally exclude switchM/confirm from the dep array — they
    // are stable across renders (mutation handle + provider hook) and
    // including them re-fires the effect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, samQ.data]);
}

/**
 * Test-only helper: clear the module-level "already asked" set so
 * tests can re-arm the prompt between cases without reloading the
 * page. Not exported from the package's public surface; tests import
 * by path.
 */
export function __resetSamReconcileDismissalsForTests(): void {
  _DISMISSED_FOR_PROJECT.clear();
}
