// Armin Mehri — mehri.armin@gmail.com
/**
 * Keyboard-first asset picker for the "copy annotations from any
 * asset" flow. Opens on Shift+P, accepts a 1-based ordinal in
 * ``[1, totalAssets]`` excluding the current asset's ordinal, calls
 * ``onPick`` on Enter, dismisses on Escape. Mirrors the existing 'g'
 * jump-to UX so the muscle memory transfers.
 */
import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/cn";

export interface CopyFromPromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  totalAssets: number;
  currentOrdinal: number;
  onPick: (ordinal: number) => void;
}

export function CopyFromPromptDialog({
  open,
  onOpenChange,
  totalAssets,
  currentOrdinal,
  onPick,
}: CopyFromPromptDialogProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft("");
      setError(null);
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [open]);

  function submit() {
    const n = parseInt(draft, 10);
    if (!Number.isFinite(n)) {
      setError("Enter a number.");
      return;
    }
    if (n < 1 || n > totalAssets) {
      setError(`Out of range — pick 1 to ${totalAssets}.`);
      return;
    }
    if (n === currentOrdinal) {
      setError("Same as current asset.");
      return;
    }
    onPick(n);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[360px]"
        data-testid="copy-prompt-dialog"
      >
        <DialogHeader>
          <DialogTitle>Copy annotations from…</DialogTitle>
          <DialogDescription className="sr-only">
            Enter the asset number to copy annotations from.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 py-2">
          <Input
            ref={inputRef}
            type="number"
            min={1}
            max={totalAssets}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onOpenChange(false);
              }
            }}
            data-testid="copy-prompt-input"
            placeholder="Asset #"
            className="w-32"
            aria-label="Asset number"
          />
          <span className="font-mono text-[12px] text-[color:var(--text-tertiary)]">
            / {totalAssets}
          </span>
        </div>
        {error && (
          <span
            className={cn(
              "text-[11.5px] text-[color:var(--danger,#d4504a)]",
            )}
            role="alert"
            data-testid="copy-prompt-error"
          >
            {error}
          </span>
        )}
      </DialogContent>
    </Dialog>
  );
}
