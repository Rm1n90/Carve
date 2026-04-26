import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, Plus } from "lucide-react";
import { classesApi, type ClassRow } from "@/api/classes";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export function ClassesEditor({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["classes", projectId],
    queryFn: () => classesApi.listForProject(projectId),
  });
  const create = useMutation({
    mutationFn: (input: { idx: number; name: string; color: string }) =>
      classesApi.create(projectId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["classes", projectId] }),
  });
  const remove = useMutation({
    mutationFn: (cid: string) => classesApi.delete(projectId, cid),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["classes", projectId] }),
  });

  const [name, setName] = useState("");
  const [color, setColor] = useState("#ff0000");
  const nextIdx = (q.data ?? []).reduce((m, c) => Math.max(m, c.idx + 1), 0);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await create.mutateAsync({ idx: nextIdx, name, color });
    setName("");
  }

  return (
    <section className="grid gap-4">
      <header className="flex items-end justify-between">
        <h2 className="text-[18px] font-medium tracking-tight text-primary">Classes</h2>
        <span className="font-mono-data text-[11px] text-tertiary">
          {q.data?.length ?? 0} defined
        </span>
      </header>

      <form
        onSubmit={onSubmit}
        className="grid gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4"
      >
        <Input
          label="Class name"
          required
          minLength={1}
          maxLength={120}
          placeholder="e.g. car, person, nucleus"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="flex items-end gap-3">
          <label className="grid gap-1.5">
            <span className="text-[12px] uppercase tracking-[0.08em] text-tertiary font-medium">
              Color
            </span>
            <input
              type="color"
              aria-label="Color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-10 w-12 cursor-pointer rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)]"
            />
          </label>
          <Button
            type="submit"
            variant="primary"
            size="md"
            loading={create.isPending}
            leftIcon={!create.isPending && <Plus className="h-4 w-4" />}
            className="flex-1"
          >
            {create.isPending ? "Adding" : "Add class"}
          </Button>
        </div>
      </form>

      {q.isLoading && <p className="text-tertiary text-[13px]">Loading…</p>}
      {q.data && q.data.length === 0 && (
        <p className="text-tertiary text-[13px] italic px-1">No classes defined yet.</p>
      )}
      <ul className="grid gap-1.5">
        {q.data?.map((c: ClassRow) => (
          <li
            key={c.id}
            className="flex items-center gap-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2 transition-colors hover:border-[var(--border-strong)]"
          >
            <span
              aria-label={`Class ${c.idx} color`}
              className="h-4 w-4 shrink-0 rounded-[3px] border border-[var(--border-strong)]"
              style={{ background: c.color }}
            />
            <span className="font-mono-data text-tertiary text-[10px] w-6">#{c.idx}</span>
            <span className="flex-1 text-[13px] tracking-tight text-primary">{c.name}</span>
            <button
              type="button"
              onClick={() => {
                if (confirm(`Delete class "${c.name}"?`)) remove.mutate(c.id);
              }}
              aria-label={`Delete class ${c.name}`}
              className="grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] text-tertiary transition-colors hover:bg-[oklch(0.70_0.20_25_/_0.10)] hover:text-[var(--danger)]"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
