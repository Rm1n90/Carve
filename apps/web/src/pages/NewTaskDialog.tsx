// Armin Mehri — mehri.armin@gmail.com
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import axios from "axios";
import { Plus } from "lucide-react";
import { tasksApi, type Task, type TaskKind } from "@/api/tasks";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";

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
  const [dueDate, setDueDate] = useState(""); // YYYY-MM-DD; empty = no schedule

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const create = useMutation<Task, unknown, void>({
    mutationFn: () =>
      tasksApi.create(projectId, {
        name,
        kind,
        // <input type="date"> emits "YYYY-MM-DD"; convert to an ISO
        // datetime at UTC midnight so the API can store it as TIMESTAMPTZ.
        due_date: dueDate ? `${dueDate}T00:00:00Z` : null,
      }),
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
      className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto] items-end rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2"
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
      <div className="grid gap-1">
        <span className="text-[10.5px] uppercase tracking-[0.08em] text-tertiary font-medium">
          Kind
        </span>
        <Select value={kind} onValueChange={(v) => setKind(v as TaskKind)}>
          <Select.Trigger aria-label="task-kind" data-testid="new-task-kind">
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="image">Image set</Select.Item>
            <Select.Item value="video">Video</Select.Item>
          </Select.Content>
        </Select>
      </div>
      <Input
        id="new-task-due-date"
        data-testid="new-task-due-date"
        type="date"
        label="Due date"
        value={dueDate}
        onChange={(e) => setDueDate(e.target.value)}
        aria-label="Task due date (optional)"
      />
      <Button
        type="submit"
        variant="primary"
        size="sm"
        loading={create.isPending}
        leftIcon={!create.isPending && <Plus className="h-3.5 w-3.5" />}
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
