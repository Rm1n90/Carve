// Armin Mehri -- mehri.armin@gmail.com
//
// v3.21 -- Settings -> Shortcuts page.
//
// Per-user keyboard customization. Users can:
//   - See every customizable action grouped by category, with a category
//     icon and a per-category "Reset category" link.
//   - Filter by label or category; matched substring is highlighted.
//   - Click an action to open a focused capture pad. The capture pad
//     suppresses every global shortcut handler while open so a captured
//     ``c`` doesn't also trigger ``convert_to_bbox``.
//   - Live conflict detection -- if the captured chord is already used
//     by another action, Save is BLOCKED and a "Move binding here"
//     button steals the chord (the conflicting action becomes unbound;
//     user can rebind from its row).
//   - Reset one action to default, reset a whole category, or reset
//     everything.
//
// Storage: ``users.shortcut_overrides`` (sparse JSONB map). Defaults
// are static and live in ``lib/shortcuts/actions.ts``; the wire format
// only ever carries the diff.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BoxSelect,
  Compass,
  Layers,
  MousePointer,
  MoveVertical,
  Pencil,
  RotateCcw,
  Search,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Kbd } from "@/components/ui/Kbd";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import {
  ACTIONS,
  CATEGORY_ORDER,
  actionsByCategory,
  findConflict,
  type ShortcutAction,
  type ShortcutCategory,
} from "@/lib/shortcuts/actions";
import {
  chordTokens,
  isValidChord,
  normalizeKeyboardEvent,
} from "@/lib/shortcuts/chord";
import {
  SHORTCUTS_QUERY_KEY,
  setShortcutCaptureActive,
  useShortcutsQuery,
} from "@/state/shortcuts";
import { shortcutsApi } from "@/api/shortcuts";
import { SettingsLayout } from "./SettingsPages";

// --------------------------------------------------------------------
// Category icons & labels
// --------------------------------------------------------------------

const CATEGORY_ICON: Record<ShortcutCategory, ReactNode> = {
  Global: <Search className="h-3.5 w-3.5" />,
  Tools: <Wrench className="h-3.5 w-3.5" />,
  Editor: <MousePointer className="h-3.5 w-3.5" />,
  Selection: <Layers className="h-3.5 w-3.5" />,
  "Z-order": <MoveVertical className="h-3.5 w-3.5" />,
  Navigation: <Compass className="h-3.5 w-3.5" />,
  Review: <ShieldCheck className="h-3.5 w-3.5" />,
  Assets: <BoxSelect className="h-3.5 w-3.5" />,
};

// --------------------------------------------------------------------
// Page
// --------------------------------------------------------------------

export function SettingsShortcutsPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const overridesQ = useShortcutsQuery();
  const overrides = overridesQ.data?.overrides ?? {};

  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<ShortcutAction | null>(null);

  const putM = useMutation({
    mutationFn: (next: Record<string, string>) => shortcutsApi.put(next),
    onSuccess: (data) => {
      qc.setQueryData(SHORTCUTS_QUERY_KEY, data);
      showToast("Shortcut saved", { variant: "success" });
    },
    onError: () => {
      showToast("Failed to save shortcut", { variant: "error" });
    },
  });

  const resetOneM = useMutation({
    mutationFn: (id: string) => shortcutsApi.resetOne(id),
    onSuccess: (data) => {
      qc.setQueryData(SHORTCUTS_QUERY_KEY, data);
      showToast("Reset to default", { variant: "success" });
    },
    onError: () => showToast("Failed to reset shortcut", { variant: "error" }),
  });

  const resetAllM = useMutation({
    mutationFn: () => shortcutsApi.resetAll(),
    onSuccess: (data) => {
      qc.setQueryData(SHORTCUTS_QUERY_KEY, data);
      showToast("All shortcuts reset", { variant: "success" });
    },
    onError: () =>
      showToast("Failed to reset shortcuts", { variant: "error" }),
  });

  // ----- Filter -----
  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const all = actionsByCategory();
    if (!f) return all;
    return all
      .map((g) => ({
        category: g.category,
        actions: g.actions.filter(
          (a) =>
            a.label.toLowerCase().includes(f) ||
            a.category.toLowerCase().includes(f) ||
            a.id.includes(f) ||
            (a.description?.toLowerCase().includes(f) ?? false),
        ),
      }))
      .filter((g) => g.actions.length > 0);
  }, [filter]);

  // ----- Resolve chord for one action (override OR default) -----
  function resolved(a: ShortcutAction): string {
    const o = overrides[a.id];
    return typeof o === "string" ? o : a.default;
  }

  // ----- Save a new chord. The conflict UX in the dialog ensures we
  //       never reach this with a chord already bound to another action;
  //       we still defensively swap if one slips through.
  function save(actionId: string, chord: string, swapWithId?: string) {
    const next: Record<string, string> = { ...overrides };
    const action = ACTIONS[actionId];
    if (action && chord === action.default) {
      delete next[actionId];
    } else {
      next[actionId] = chord;
    }
    if (swapWithId && chord) {
      // Take the conflicting action's chord away. If its default IS the
      // chord we just stole, persist an empty-string override so the
      // default doesn't shadow our new binding. Otherwise drop any
      // explicit override (its default takes over again).
      if (ACTIONS[swapWithId].default === chord) {
        next[swapWithId] = "";
      } else {
        delete next[swapWithId];
      }
    }
    putM.mutate(next);
  }

  // ----- Reset every action in one category to its default -----
  async function resetCategory(category: ShortcutCategory) {
    const ok = await confirm({
      title: `Reset ${category} shortcuts?`,
      description:
        `Every shortcut in the ${category} category will revert to its default.`,
      confirmLabel: "Reset",
      variant: "danger",
    });
    if (!ok) return;
    const next: Record<string, string> = { ...overrides };
    for (const id of Object.keys(ACTIONS)) {
      if (ACTIONS[id].category === category) {
        delete next[id];
      }
    }
    putM.mutate(next);
  }

  return (
    <SettingsLayout>
      <Card variant="surface" radius="lg" className="p-6 grid gap-5">
        <header className="flex items-baseline justify-between gap-4">
          <div>
            <h2 className="text-[16px] font-semibold tracking-tight">
              Keyboard shortcuts
            </h2>
            <p className="text-[13px] text-[color:var(--text-secondary)] mt-1">
              Customize the keyboard shortcuts for your account. Changes
              are private -- they never affect other users.
            </p>
          </div>
          <Button
            variant="ghost"
            size="md"
            leftIcon={<RotateCcw className="h-4 w-4" />}
            onClick={async () => {
              const ok = await confirm({
                title: "Restore all defaults?",
                description:
                  "Every shortcut on your account will revert to its default. This cannot be undone.",
                confirmLabel: "Restore",
                variant: "danger",
              });
              if (ok) resetAllM.mutate();
            }}
            data-testid="shortcuts-reset-all"
            disabled={
              resetAllM.isPending || Object.keys(overrides).length === 0
            }
          >
            Restore all defaults
          </Button>
        </header>

        <Input
          aria-label="Filter shortcuts"
          placeholder="Filter by name, description, or category..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          leftIcon={<Search className="h-4 w-4" />}
          data-testid="shortcuts-filter"
        />

        {overridesQ.isLoading && (
          <p className="text-[13px] text-[color:var(--text-tertiary)]">
            Loading...
          </p>
        )}
      </Card>

      {groups.map((g) => {
        const categoryHasOverride = g.actions.some(
          (a) => typeof overrides[a.id] === "string",
        );
        return (
          <Card
            key={g.category}
            variant="surface"
            radius="lg"
            className="p-6 grid gap-3"
            data-testid={`shortcuts-group-${g.category}`}
          >
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="flex items-center gap-2 font-mono text-[10px] tracking-[0.18em] uppercase text-[color:var(--text-tertiary)]">
                <span aria-hidden className="inline-flex items-center">
                  {CATEGORY_ICON[g.category]}
                </span>
                {g.category}
              </h3>
              {categoryHasOverride && (
                <button
                  type="button"
                  onClick={() => resetCategory(g.category)}
                  className={cn(
                    "text-[11px] tracking-tight underline-offset-2",
                    "text-[color:var(--text-tertiary)]",
                    "hover:text-[color:var(--text-primary)] hover:underline",
                  )}
                  data-testid={`shortcuts-reset-category-${g.category}`}
                >
                  Reset category
                </button>
              )}
            </div>
            <ul className="grid gap-1.5">
              {g.actions.map((a) => {
                const chord = resolved(a);
                const isCustomized = chord !== a.default;
                return (
                  <li
                    key={a.id}
                    className={cn(
                      "rounded-[var(--radius-md)] border border-[var(--border-subtle)]",
                      "bg-[var(--bg-elev)] px-4 py-2.5",
                      "grid grid-cols-[1fr_auto_auto] items-center gap-3",
                    )}
                    data-testid={`shortcut-row-${a.id}`}
                  >
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium tracking-tight truncate flex items-center gap-1.5">
                        <Highlight text={a.label} match={filter} />
                        {isCustomized && (
                          <span
                            aria-label="Customized"
                            title="Customized"
                            className="inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--accent)] shrink-0"
                            data-testid={`shortcut-dirty-${a.id}`}
                          />
                        )}
                      </p>
                      {a.description && (
                        <p className="text-[11.5px] text-[color:var(--text-tertiary)] mt-0.5 truncate">
                          <Highlight text={a.description} match={filter} />
                        </p>
                      )}
                    </div>
                    <ChordDisplay chord={chord} />
                    <div className="flex items-center gap-1">
                      {isCustomized && (
                        <button
                          type="button"
                          aria-label={`Reset ${a.label} to default`}
                          title="Reset to default"
                          onClick={() => resetOneM.mutate(a.id)}
                          className={cn(
                            "grid h-7 w-7 place-items-center rounded-[var(--radius-sm)]",
                            "text-[color:var(--text-tertiary)]",
                            "hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
                          )}
                          data-testid={`shortcut-reset-${a.id}`}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={`Edit ${a.label}`}
                        title="Edit shortcut"
                        onClick={() => setEditing(a)}
                        className={cn(
                          "grid h-7 w-7 place-items-center rounded-[var(--radius-sm)]",
                          "text-[color:var(--text-tertiary)]",
                          "hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
                        )}
                        data-testid={`shortcut-edit-${a.id}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        );
      })}

      {groups.length === 0 && (
        <Card variant="surface" radius="lg" className="p-6">
          <p className="text-[13px] text-[color:var(--text-tertiary)] italic">
            No shortcuts match "{filter}".
          </p>
        </Card>
      )}

      <EditShortcutDialog
        open={!!editing}
        action={editing}
        currentChord={editing ? resolved(editing) : ""}
        overrides={overrides}
        onCancel={() => setEditing(null)}
        onResetToDefault={() => {
          if (!editing) return;
          resetOneM.mutate(editing.id);
          setEditing(null);
        }}
        onSave={(chord, swapWithId) => {
          if (!editing) return;
          save(editing.id, chord, swapWithId);
          setEditing(null);
        }}
      />
    </SettingsLayout>
  );
}

// --------------------------------------------------------------------
// Display helpers
// --------------------------------------------------------------------

function ChordDisplay({ chord }: { chord: string }) {
  if (!chord) {
    return (
      <span className="text-[12px] text-[color:var(--text-tertiary)] italic">
        Unbound
      </span>
    );
  }
  const tokens = chordTokens(chord);
  return (
    <span className="flex items-center gap-1">
      {tokens.map((t, i) => (
        <Kbd key={i}>{t}</Kbd>
      ))}
    </span>
  );
}

/** Wrap matched substrings of ``text`` with a subtle highlight span. */
function Highlight({ text, match }: { text: string; match: string }) {
  const m = match.trim();
  if (!m) return <>{text}</>;
  const lower = text.toLowerCase();
  const ml = m.toLowerCase();
  const idx = lower.indexOf(ml);
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <span className="text-[color:var(--accent)] font-semibold">
        {text.slice(idx, idx + m.length)}
      </span>
      {text.slice(idx + m.length)}
    </>
  );
}

// --------------------------------------------------------------------
// Edit dialog
// --------------------------------------------------------------------

interface EditDialogProps {
  open: boolean;
  action: ShortcutAction | null;
  currentChord: string;
  overrides: Record<string, string>;
  onCancel: () => void;
  onResetToDefault: () => void;
  onSave: (chord: string, swapWithId?: string) => void;
}

function EditShortcutDialog({
  open,
  action,
  currentChord,
  overrides,
  onCancel,
  onResetToDefault,
  onSave,
}: EditDialogProps) {
  const [captured, setCaptured] = useState<string>("");

  // Reset capture state whenever the dialog opens for a new action and
  // toggle the global capture flag so app-wide useShortcutHandler
  // listeners stay quiet during capture.
  useEffect(() => {
    if (open) {
      setCaptured("");
      setShortcutCaptureActive(true);
      return () => {
        setShortcutCaptureActive(false);
      };
    }
  }, [open, action?.id]);

  // Capture loop. Backspace-with-no-modifier clears; Esc cancels;
  // anything else is normalized into the chord string.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
        return;
      }
      // Backspace with no modifiers and nothing-else-pressed means
      // "clear the captured chord and keep waiting".
      if (
        e.key === "Backspace" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        captured !== ""
      ) {
        e.preventDefault();
        e.stopPropagation();
        setCaptured("");
        return;
      }
      const next = normalizeKeyboardEvent(e);
      if (next === null) return;
      e.preventDefault();
      e.stopPropagation();
      if (isValidChord(next)) {
        setCaptured(next);
      }
    }
    // useCapture: true so we run before any other (real) listener even
    // if the global capture flag fails for some reason.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onCancel, captured]);

  // Conflict detection: the captured chord is already used by some
  // other action (resolved through override-or-default).
  const conflictId = useMemo(() => {
    if (!captured || !action) return null;
    return findConflict(captured, action.id, overrides);
  }, [captured, action, overrides]);
  const conflict = conflictId ? ACTIONS[conflictId] : null;

  const isUnchanged = captured === currentChord;
  const canSave = captured !== "" && !isUnchanged && !conflict;
  const saveTooltip = !captured
    ? "Press a key to bind this shortcut."
    : isUnchanged
      ? "Pick a different chord to save."
      : conflict
        ? "Resolve the conflict to save."
        : undefined;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Edit shortcut{action ? `: ${action.label}` : ""}
          </DialogTitle>
          <DialogDescription>
            Press the new shortcut combination. The capture pad below
            takes over your keyboard while open.
          </DialogDescription>
        </DialogHeader>

        {/* ----- Capture pad ----- */}
        <div
          className={cn(
            "rounded-[var(--radius-md)] border-2 border-dashed",
            "border-[var(--accent)] bg-[var(--bg-subtle)]",
            "px-6 py-10 grid place-items-center gap-4 min-h-[200px]",
            "shadow-[0_0_0_4px_var(--accent-bg),inset_0_1px_0_var(--glass-highlight)]",
            "transition-all duration-200",
          )}
          data-testid="shortcut-capture-area"
          role="presentation"
          tabIndex={-1}
        >
          <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-[color:var(--text-tertiary)]">
            Capture
          </span>
          {captured ? (
            <div
              className="flex items-center gap-1.5"
              data-testid="shortcut-capture-display"
            >
              <ChordDisplay chord={captured} />
            </div>
          ) : (
            <span className="text-[15px] text-[color:var(--text-tertiary)] italic">
              Press a key&hellip;
            </span>
          )}
          <span className="text-[11px] text-[color:var(--text-tertiary)] italic mt-1">
            Esc to cancel &middot; keep modifier keys held while pressing
            the final key &middot; Backspace to clear
          </span>
        </div>

        {/* ----- Currently bound display ----- */}
        <div className="mt-2 flex items-center justify-between text-[11.5px] text-[color:var(--text-tertiary)]">
          <span>
            Currently bound to:{" "}
            {currentChord ? <ChordDisplay chord={currentChord} /> : (
              <em>Unbound</em>
            )}
          </span>
          {action && action.default && (
            <span>
              Default: <ChordDisplay chord={action.default} />
            </span>
          )}
        </div>

        {/* ----- Conflict banner ----- */}
        {conflict && (
          <div
            className={cn(
              "mt-2 grid gap-2 rounded-[var(--radius-sm)] px-3 py-2.5",
              "border border-[var(--warning,var(--accent))]",
              "bg-[color:var(--warning-bg,var(--accent-bg))]",
            )}
            data-testid="shortcut-conflict"
          >
            <p className="text-[12.5px] text-[color:var(--text-primary)] flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-[1px] shrink-0 text-[color:var(--warning,var(--accent))]" />
              <span>
                Already used by <strong>{conflict.label}</strong>. Pick
                a different chord, or move the binding here -- the
                conflicting action will become unbound.
              </span>
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCaptured("")}
                data-testid="shortcut-conflict-dismiss"
              >
                Try a different chord
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => onSave(captured, conflict.id)}
                data-testid="shortcut-conflict-swap"
              >
                Move binding here
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={onResetToDefault}
            disabled={!action}
            data-testid="shortcut-edit-reset"
          >
            Reset to default
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!canSave}
            onClick={() => captured && !conflict && onSave(captured)}
            title={saveTooltip}
            data-testid="shortcut-edit-save"
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Re-export the categories to ease tests/storybook.
export const _SHORTCUT_CATEGORIES = CATEGORY_ORDER;

