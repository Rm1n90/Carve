// Armin Mehri — mehri.armin@gmail.com
/**
 * Headless watcher that owns the "SAM variant ready / failed" toast
 * regardless of which surface initiated the switch.
 *
 * Problem this solves: the compact ``SamVariantSwitcher`` lives inside
 * a Radix popover in the editor toolbar. When the user closes that
 * popover (or the dismissable overlay) the switcher component
 * unmounts — and any background poll owned by it disappears with it.
 * The model finishes loading silently. No toast, no event.
 *
 * Fix: lift the poll into this component, mount it once at the app
 * shell level, and listen for ``carve:sam-variant-switching`` events
 * (already dispatched by ``SamVariantSwitcher`` on every mutate).
 * When the model reaches ``ready`` we fire
 * ``carve:sam-variant-ready`` + show a success toast; on ``error`` we
 * surface a failure toast.
 *
 * A ``sawNonReadyRef`` guard prevents false positives if the very
 * first poll happens to land on a stale ``ready`` state (e.g. the
 * mutation failed before the model service even started loading) —
 * we only fire the ready toast after observing a non-ready state
 * first.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { modelsApi, type SamLoadStatus } from "@/api/phase2";
import { showToast } from "@/lib/toast";

const POLL_INTERVAL_MS = 1500;
// Belt + braces: even if the model service hangs on "loading"
// forever, stop polling after this many ms so we don't keep
// hammering the endpoint.
const WATCHER_TIMEOUT_MS = 5 * 60 * 1000;

export function SamSwitchWatcher() {
  const qc = useQueryClient();
  const [switchInFlight, setSwitchInFlight] = useState(false);
  const [hintedVariant, setHintedVariant] = useState<string | null>(null);
  const lastStateRef = useRef<string | null>(null);
  const sawNonReadyRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function onSwitching(e: Event) {
      const detail = (e as CustomEvent<{ variant?: string | null }>).detail;
      const variant = detail?.variant ?? null;
      // Reset transition tracking — every switch starts a fresh
      // observation window.
      lastStateRef.current = null;
      sawNonReadyRef.current = false;
      setHintedVariant(variant);
      setSwitchInFlight(true);
      // Cap the watcher so a stuck load doesn't keep polling forever.
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        setSwitchInFlight(false);
      }, WATCHER_TIMEOUT_MS);
    }
    window.addEventListener("carve:sam-variant-switching", onSwitching);
    return () => {
      window.removeEventListener("carve:sam-variant-switching", onSwitching);
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, []);

  const statusPollQ = useQuery<SamLoadStatus>({
    queryKey: ["sam-switch-watcher"],
    queryFn: () => modelsApi.samStatus(),
    enabled: switchInFlight,
    refetchInterval: switchInFlight ? POLL_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });

  const pollState = statusPollQ.data?.state;
  const pollVariant = statusPollQ.data?.variant;
  const pollError = statusPollQ.data?.error;

  useEffect(() => {
    if (!switchInFlight) {
      lastStateRef.current = null;
      sawNonReadyRef.current = false;
      return;
    }
    const prev = lastStateRef.current;
    if (!pollState || pollState === prev) return;
    lastStateRef.current = pollState;
    if (pollState !== "ready") {
      // Any non-ready observation arms the ready-detector. Once
      // armed, the next "ready" transition is genuinely ours.
      sawNonReadyRef.current = true;
    }
    // Defence against the race window between POST /sam/switch returning
    // 202 and the model-service worker thread actually flipping
    // state→loading: during that window /sam/status still reports the
    // OLD variant as "ready". Without this check, the watcher would
    // fire a "SAM <old> ready" toast immediately on the first poll.
    // Only treat "ready" as ours when /sam/status reflects the variant
    // the user actually requested.
    const targetVariant = hintedVariant;
    const variantMatches =
      !targetVariant || !pollVariant || pollVariant === targetVariant;
    if (
      pollState === "ready"
      && sawNonReadyRef.current
      && variantMatches
    ) {
      setSwitchInFlight(false);
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      const variant = pollVariant ?? hintedVariant ?? null;
      window.dispatchEvent(
        new CustomEvent("carve:sam-variant-ready", {
          detail: { variant },
        }),
      );
      showToast(
        variant ? `SAM ${variant} ready` : "SAM model ready",
        { variant: "success", duration: 2800 },
      );
      void qc.invalidateQueries({ queryKey: ["sam-active"] });
    } else if (pollState === "error") {
      setSwitchInFlight(false);
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      const detail = pollError || "model_load_failed";
      const reason =
        detail === "model_load_failed" || !detail
          ? "Try switching variants again."
          : detail;
      showToast(`SAM load failed: ${reason}`, { variant: "error" });
    }
  }, [
    switchInFlight,
    pollState,
    pollVariant,
    pollError,
    hintedVariant,
    qc,
  ]);

  return null;
}
