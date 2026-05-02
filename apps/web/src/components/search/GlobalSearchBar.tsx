// Armin Mehri — mehri.armin@gmail.com
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Search } from "lucide-react";
import { searchApi, type SearchAssetHit } from "@/api/search";
import { cn } from "@/lib/cn";

/**
 * Plan-13 Phase 7 Task 9 — workspace-wide command palette.
 *
 * Mounts at the root level so the Cmd/Ctrl-K keybinding works on every
 * page. Renders a clickable trigger pill plus a Radix Dialog for the
 * actual palette.
 */
export function GlobalSearchBar() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");
  const navigate = useNavigate();

  // Cmd/Ctrl-K toggles the palette globally.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 200 ms debounce per spec.
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(text), 200);
    return () => window.clearTimeout(t);
  }, [text]);

  const [items, setItems] = useState<SearchAssetHit[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open || debounced.trim().length === 0) {
      setItems([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void searchApi
      .assets({ q: debounced, workspace: true, limit: 20 })
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
      })
      .catch(() => {
        if (cancelled) return;
        setItems([]);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, debounced]);

  function navigateToHit(hit: SearchAssetHit): void {
    setOpen(false);
    setText("");
    setDebounced("");
    navigate({
      to: `/projects/${hit.project_id}/tasks/${hit.task_id}/assets/${hit.asset_id}`,
    });
  }

  return (
    <>
      <button
        type="button"
        data-testid="global-search-trigger"
        onClick={() => setOpen(true)}
        className={cn(
          "relative z-10 flex items-center gap-2 h-7 px-2 rounded-full",
          "glass-chip text-[12.5px] tracking-tight",
          "text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)]",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
        )}
        aria-label="Open search (Cmd-K)"
      >
        <Search className="h-3.5 w-3.5" />
        <span>Search…</span>
        <span className="ml-1 inline-flex items-center gap-0.5 text-[10px] font-mono text-[color:var(--text-tertiary)]">
          <kbd className="rounded border border-[var(--border-subtle)] px-1">⌘</kbd>
          <kbd className="rounded border border-[var(--border-subtle)] px-1">K</kbd>
        </span>
      </button>

      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-[900] bg-[rgba(15,23,42,0.32)]" />
          <DialogPrimitive.Content
            data-testid="global-search-dialog"
            style={{ transform: "translate(-50%, -50%)" }}
            className={cn(
              "fixed left-1/2 top-1/3 z-[901]",
              "w-[min(92vw,640px)] max-h-[70vh] overflow-hidden",
              "rounded-[var(--radius-lg)] glass-surface-strong p-3 outline-none",
            )}
          >
            <DialogPrimitive.Title className="sr-only">
              Search assets
            </DialogPrimitive.Title>
            <SearchInput
              value={text}
              onChange={setText}
              onEnter={() => items.length > 0 && navigateToHit(items[0])}
            />
            <div
              data-testid="global-search-results"
              className="max-h-[50vh] overflow-y-auto"
            >
              {loading && debounced && (
                <p className="px-3 py-4 text-[12px] text-[color:var(--text-tertiary)]">
                  Searching…
                </p>
              )}
              {!loading && debounced && items.length === 0 && (
                <p className="px-3 py-4 text-[12px] text-[color:var(--text-tertiary)]">
                  No matches.
                </p>
              )}
              <ul className="m-0 p-0 list-none">
                {items.map((hit) => (
                  <li key={hit.asset_id}>
                    <button
                      type="button"
                      data-testid={`global-search-result-${hit.asset_id}`}
                      onClick={() => navigateToHit(hit)}
                      className={cn(
                        "flex w-full items-center gap-3 px-2 py-2 rounded-[var(--radius-xs)]",
                        "hover:bg-[var(--bg-hover)] text-left",
                      )}
                    >
                      <span className="grid h-8 w-8 place-items-center rounded bg-[var(--bg-subtle)] overflow-hidden shrink-0">
                        {hit.thumbnail_url ? (
                          <img
                            src={hit.thumbnail_url}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <Search className="h-3.5 w-3.5 text-[color:var(--text-tertiary)]" />
                        )}
                      </span>
                      <span className="flex flex-col min-w-0">
                        <span className="text-[13px] truncate text-[color:var(--text-primary)]">
                          {hit.original_name}
                        </span>
                        <span className="text-[11px] truncate text-[color:var(--text-tertiary)]">
                          {hit.project_name} › {hit.task_name}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}

function SearchInput({
  value,
  onChange,
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  onEnter: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div className="flex items-center gap-2 px-2 py-2 border-b border-[var(--border-subtle)]">
      <Search className="h-4 w-4 text-[color:var(--text-tertiary)]" />
      <input
        ref={ref}
        data-testid="global-search-input"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onEnter();
          }
        }}
        placeholder="Search assets across the workspace…"
        className={cn(
          "flex-1 bg-transparent outline-none text-[14px]",
          "text-[color:var(--text-primary)] placeholder:text-[color:var(--text-tertiary)]",
        )}
      />
    </div>
  );
}
