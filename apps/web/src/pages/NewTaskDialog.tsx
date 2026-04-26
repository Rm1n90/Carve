import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { tasksApi, type TaskKind } from "@/api/tasks";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export function NewTaskDialog({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TaskKind>("image");
  const create = useMutation({
    mutationFn: () => tasksApi.create(projectId, { name, kind }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks", projectId] });
      setName("");
      onCreated();
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <form
      onSubmit={onSubmit}
      className="grid gap-3 sm:grid-cols-[1fr_auto_auto] items-end rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3"
    >
      <Input
        label="Task name"
        required
        minLength={1}
        maxLength={120}
        placeholder="e.g. winter-scenes-batch-3"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <label className="grid gap-1.5">
        <span className="text-[12px] uppercase tracking-[0.08em] text-tertiary font-medium">
          Kind
        </span>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as TaskKind)}
          className="h-10 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 text-[14px] text-primary focus:outline-none focus:border-[var(--accent)]"
        >
          <option value="image">Image set</option>
          <option value="video">Video</option>
        </select>
      </label>
      <Button
        type="submit"
        variant="primary"
        loading={create.isPending}
        leftIcon={!create.isPending && <Plus className="h-4 w-4" />}
      >
        {create.isPending ? "Creating" : "Add task"}
      </Button>
    </form>
  );
}
