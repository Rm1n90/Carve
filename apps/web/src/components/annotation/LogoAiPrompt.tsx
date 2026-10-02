// Armin Mehri — mehri.armin@gmail.com
/**
 * Logo AI — the task's own instructions.
 *
 * What counts as a logo is not the same in every task, so the text the
 * model is given can be edited per task: one for detection, one for the
 * second pass. Only the instructions are editable. The description of
 * coordinates, output rows and classes is added after them on every
 * request and is shown here for reference: it is what the answer is
 * parsed by, and a prompt that described it differently would put boxes
 * in the wrong place.
 *
 * A run keeps the text it was started with; saving here changes the
 * next run.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { logoAiApi, type LogoAiTaskPrompt as Prompt } from "@/api/logoAi";
import { Button } from "@/components/ui/Button";
import { showToast } from "@/lib/toast";

interface LogoAiPromptProps {
  taskId: string;
  /** The provider and model selected in the dialog: the fixed part of
   *  the prompt depends on the model's coordinate system. */
  providerId?: string;
  modelId?: string;
  /** Editing is offered only to those who may start runs. */
  onClose: () => void;
}

function Editor({
  label,
  hint,
  value,
  onChange,
  isDefault,
  onReset,
  fixed,
  minCacheChars,
  maxChars,
  testId,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  isDefault: boolean;
  onReset: () => void;
  fixed: string;
  minCacheChars: number;
  maxChars: number;
  testId: string;
}) {
  const chars = value.trim().length;
  return (
    <section className="grid gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] font-medium">{label}</span>
        <span
          data-testid={`${testId}-state`}
          className="px-1.5 py-px rounded-[var(--radius-sm)] text-[10px] font-medium uppercase tracking-[0.4px] bg-[var(--bg-subtle)] text-[color:var(--text-secondary)]"
        >
          {isDefault ? "Default" : "Custom for this task"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={isDefault}
          onClick={onReset}
          data-testid={`${testId}-reset`}
        >
          Reset to default
        </Button>
      </div>
      <span className="text-[11px] text-[color:var(--text-secondary)]">{hint}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={maxChars}
        spellCheck={false}
        data-testid={testId}
        className="h-[220px] w-full resize-y p-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] font-mono leading-[1.45] text-[color:var(--text-primary)]"
      />
      <div className="flex items-center justify-between text-[10.5px] text-[color:var(--text-tertiary)]">
        <span>
          {chars.toLocaleString()} characters, about {Math.round(chars / 4).toLocaleString()} tokens
        </span>
        {chars > 0 && chars < minCacheChars && (
          <span data-testid={`${testId}-short`} className="text-[color:var(--warning)]">
            Under about 1,024 tokens the provider does not cache it: every image then pays
            for the whole text.
          </span>
        )}
      </div>
      <details className="text-[11px] text-[color:var(--text-secondary)]">
        <summary className="cursor-pointer select-none">
          Added after your text on every request (not editable)
        </summary>
        <pre className="mt-1 p-2 max-h-[160px] overflow-auto whitespace-pre-wrap rounded-[var(--radius-md)] bg-[var(--bg-subtle)] font-mono text-[10.5px]">
          {fixed}
        </pre>
      </details>
    </section>
  );
}

export function LogoAiPrompt({ taskId, providerId, modelId, onClose }: LogoAiPromptProps) {
  const qc = useQueryClient();
  const params = { provider: providerId, model: modelId };
  const promptQ = useQuery({
    queryKey: ["logo-ai", "prompt", taskId, providerId ?? "", modelId ?? ""],
    queryFn: () => logoAiApi.getPrompt(taskId, params),
    staleTime: 30_000,
  });
  const saved = promptQ.data;

  const [instructions, setInstructions] = useState("");
  const [checkInstructions, setCheckInstructions] = useState("");
  // Load the saved texts once per task; a refetch for another model
  // (which only changes the fixed part) must not undo what was typed.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  useEffect(() => {
    if (!saved || loadedFor === taskId) return;
    setInstructions(saved.instructions);
    setCheckInstructions(saved.check_instructions);
    setLoadedFor(taskId);
  }, [saved, taskId, loadedFor]);

  const save = useMutation({
    mutationFn: () =>
      logoAiApi.savePrompt(
        taskId,
        { instructions, check_instructions: checkInstructions },
        params,
      ),
    onSuccess: (next: Prompt) => {
      qc.setQueryData(["logo-ai", "prompt", taskId, providerId ?? "", modelId ?? ""], next);
      qc.invalidateQueries({ queryKey: ["logo-ai", "prompt", taskId] });
      setInstructions(next.instructions);
      setCheckInstructions(next.check_instructions);
      showToast(
        next.custom || next.check_custom
          ? "Saved. The next Logo AI run on this task uses these instructions."
          : "Saved. This task uses the default instructions.",
        { variant: "success", duration: 5000 },
      );
    },
    onError: (err) => {
      const e = err as { response?: { data?: { message?: string } }; message?: string };
      showToast(`Could not save: ${e?.response?.data?.message ?? e?.message ?? "request failed"}`, {
        variant: "error",
        duration: 7000,
      });
    },
  });

  if (!saved) {
    return (
      <div className="grid place-items-center min-h-[180px] text-[12px] text-[color:var(--text-secondary)]">
        {promptQ.isError ? (
          "Could not load the instructions."
        ) : (
          <span className="inline-flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Loading…
          </span>
        )}
      </div>
    );
  }

  const same = (a: string, b: string) => a.trim() === b.trim();
  const dirty =
    !same(instructions, saved.instructions) || !same(checkInstructions, saved.check_instructions);

  return (
    <>
      <div
        data-testid="logo-ai-prompt"
        className="grid gap-4 max-h-[calc(88vh-300px)] min-h-[180px] overflow-y-auto pr-2 text-[12px]"
      >
        <span className="text-[11px] text-[color:var(--text-secondary)]">
          These are the instructions the model works from on this task. Change them when the
          task needs other rules than the default: what counts as a logo here, what never
          does. A run keeps the text it was started with, so saving changes the next run.
        </span>
        <Editor
          label="Detection instructions"
          hint="What to box and what to leave, how tight, and how to score visibility and confidence."
          value={instructions}
          onChange={setInstructions}
          isDefault={same(instructions, saved.default_instructions)}
          onReset={() => setInstructions(saved.default_instructions)}
          fixed={saved.format_preview}
          minCacheChars={saved.cache_min_chars}
          maxChars={saved.max_chars}
          testId="logo-ai-prompt-instructions"
        />
        <Editor
          label="Double-check instructions"
          hint="Used by the second look at each box. Keep the 0–100 scale: boxes scored under 40 are dropped. If you change what counts as a logo above, change it here too, or the check will reject what detection was told to find."
          value={checkInstructions}
          onChange={setCheckInstructions}
          isDefault={same(checkInstructions, saved.default_check_instructions)}
          onReset={() => setCheckInstructions(saved.default_check_instructions)}
          fixed={saved.check_format_preview}
          minCacheChars={saved.cache_min_chars}
          maxChars={saved.max_chars}
          testId="logo-ai-prompt-check"
        />
      </div>
      <div className="flex items-center justify-end gap-2 pt-3">
        <Button variant="ghost" size="md" onClick={onClose}>
          Close
        </Button>
        <Button
          size="md"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}
          data-testid="logo-ai-prompt-save"
        >
          {save.isPending ? "Saving…" : dirty ? "Save for this task" : "Saved"}
        </Button>
      </div>
    </>
  );
}
