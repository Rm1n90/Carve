// Armin Mehri — mehri.armin@gmail.com
/**
 * Inline connection-state indicator for the realtime channel.
 *
 * Render rules:
 *   * ``connected`` — render nothing (no chrome cost during normal
 *     operation; the chips next to this are the success signal).
 *   * ``connecting``  — first-load. Visible only briefly so the user
 *     knows the editor is establishing the WS. A small spinner with
 *     no aggressive copy.
 *   * ``reconnecting`` — dropped after a successful connect. Now this
 *     is the user-facing signal that's worth being a bit louder —
 *     amber + attempt count.
 *   * ``disconnected`` — terminal (invalid ticket / auth failure).
 *     Red banner, no attempt count.
 *
 * Reads :func:`useConnectionStatus` directly so no parent prop-
 * drilling. ``idle`` (pre-mount) shares the connected branch
 * (renders nothing) so the indicator doesn't flash on first paint.
 */

import { AlertTriangle, Loader2, WifiOff } from "lucide-react";

import { useConnectionStatus } from "@/realtime/connectionStatus";
import { cn } from "@/lib/cn";

export function PresenceConnectionStatus() {
  const status = useConnectionStatus((s) => s.status);
  const attempt = useConnectionStatus((s) => s.reconnectAttempt);
  const lastError = useConnectionStatus((s) => s.lastError);

  if (status === "idle" || status === "connected") return null;

  const palette = (() => {
    switch (status) {
      case "connecting":
        return {
          bg: "bg-[color-mix(in_oklab,var(--text-tertiary)_10%,transparent)]",
          fg: "text-[color:var(--text-tertiary)]",
          icon: <Loader2 className="h-3 w-3 animate-spin" aria-hidden />,
        };
      case "reconnecting":
        return {
          bg: "bg-[color-mix(in_oklab,#fbbf24_18%,transparent)]",
          fg: "text-[#fbbf24]",
          icon: <AlertTriangle className="h-3 w-3" aria-hidden />,
        };
      case "disconnected":
      default:
        return {
          bg: "bg-[color-mix(in_oklab,#f87171_18%,transparent)]",
          fg: "text-[#f87171]",
          icon: <WifiOff className="h-3 w-3" aria-hidden />,
        };
    }
  })();

  const label = (() => {
    if (status === "connecting") return "Connecting…";
    if (status === "reconnecting") {
      return attempt > 1
        ? `Reconnecting (attempt ${attempt})…`
        : "Reconnecting…";
    }
    // disconnected — show the underlying reason when it's useful, but
    // keep the prefix human-readable.
    if (lastError === "invalid_ticket") return "Disconnected — please refresh";
    if (lastError === "unauthorized") return "Disconnected — sign in again";
    return "Disconnected";
  })();

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="presence-connection-status"
      data-state={status}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[var(--radius-sm)]",
        "px-2 py-0.5 text-[10.5px] font-medium tracking-tight",
        "border border-[var(--border-subtle)]",
        palette.bg,
        palette.fg,
      )}
    >
      {palette.icon}
      <span>{label}</span>
    </div>
  );
}
