// Armin Mehri — mehri.armin@gmail.com
/**
 * Toolbar avatars for every collaborator currently connected to the
 * active task. Each entry is a colored dot with the user's initials
 * (or a single letter from their name) and a hover tooltip showing the
 * full display name.
 *
 * Read-only consumer of :func:`usePresence` — no callbacks, no
 * outbound traffic. Phase 7 will add an optional "X is editing this
 * annotation" tag inline with the chips, but in Phase 6 the chip
 * itself is the surface.
 */

import { useMemo } from "react";

import { Tooltip } from "@/components/ui/Tooltip";
import { useConnectionStatus } from "@/realtime/connectionStatus";
import { usePresence, type PresenceUser } from "@/realtime/presence";
import { cn } from "@/lib/cn";

/** First letter of the name, uppercased. Empty name → "?". */
function initialFor(name: string): string {
  const first = name.trim()[0];
  return first ? first.toUpperCase() : "?";
}

interface ChipProps {
  user: PresenceUser;
  /** When true, paints a small ring to signal that this chip is the
   *  local tab — present so a future "show me too" toggle has a hook,
   *  but in Phase 6 always false because we only render OTHER users. */
  isSelf?: boolean;
}

function PresenceChip({ user, isSelf = false }: ChipProps) {
  return (
    <Tooltip content={user.name}>
      <span
        aria-label={`${user.name} is editing this task`}
        data-testid={`presence-chip-${user.session_id}`}
        className={cn(
          "inline-flex h-6 w-6 items-center justify-center",
          "rounded-full text-[10.5px] font-medium tracking-tight",
          "text-white shadow-sm select-none",
          isSelf && "ring-2 ring-[var(--accent)] ring-offset-1 ring-offset-[var(--surface)]",
        )}
        style={{ background: user.color }}
      >
        {initialFor(user.name)}
      </span>
    </Tooltip>
  );
}

/**
 * Render a row of presence chips. Returns ``null`` when nobody else
 * is connected — no empty bar.
 *
 * Sorts by ``session_id`` so the order is stable across renders (the
 * underlying ``bySession`` map iteration order isn't formally
 * guaranteed across JS engines).
 */
export function PresenceChips() {
  const bySession = usePresence((s) => s.bySession);
  const selfSession = useConnectionStatus((s) => s.currentSessionId);

  const others = useMemo(() => {
    const list = Object.values(bySession).filter(
      (u) => u.session_id !== selfSession,
    );
    list.sort((a, b) => a.session_id.localeCompare(b.session_id));
    return list;
  }, [bySession, selfSession]);

  if (others.length === 0) return null;

  return (
    <div
      role="group"
      aria-label="Other users on this task"
      data-testid="presence-chips"
      className="flex items-center gap-1.5"
    >
      {others.map((user) => (
        <PresenceChip key={user.session_id} user={user} />
      ))}
    </div>
  );
}
