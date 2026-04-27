import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import axios from "axios";
import { Plus } from "lucide-react";
import { tasksApi, type Task, type TaskKind } from "@/api/tasks";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

function extractErrorCode(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { error?: string } | undefined;
    if (data?.error) return data.error;
    if (error.response?.status) return `http_${error.response.status}`;
    return error.code ?? "network_error";
  }
  if (error instanceof Error) return error.message;
  return "unknown_error";
}

export function NewTaskDialog({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TaskKind>("image");

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const create = useMutation<Task, unknown, void>({
    mutationFn: () => tasksApi.create(projectId, { name, kind }),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["tasks", projectId] });
      setName("");
      onCreated();
      navigate({
        to: "/projects/$projectId/tasks/$taskId",
        params: { projectId, taskId: created.id },
      });
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
        ref={inputRef}
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
      {create.error != null ? (
        <p
          role="alert"
          data-testid="new-task-error"
          className="sm:col-span-3 text-[12.5px] text-[color:var(--danger)]"
        >
          Failed to create task: {extractErrorCode(create.error)}
        </p>
      ) : null}
    </form>
  );
}
