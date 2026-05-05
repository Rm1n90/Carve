// Armin Mehri — mehri.armin@gmail.com
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import {
  isFilterGroup,
  makeEmptyGroup,
  makeEmptyRule,
  type FilterField,
  type FilterGroup,
  type FilterOp,
  type FilterRule,
} from "@/lib/annotation-filter";
import { useFilter } from "@/state/annotationFilter";
import { cn } from "@/lib/cn";

const RECENT_KEY = "carve.filters.recent.v1";
const RECENT_CAP = 5;

const FIELD_OPTIONS: { value: FilterField; label: string }[] = [
  { value: "label", label: "Label" },
  { value: "kind", label: "Type" },
  { value: "width", label: "Width" },
  { value: "height", label: "Height" },
  { value: "obj_id", label: "ObjectID" },
];

const OP_OPTIONS: { value: FilterOp; label: string }[] = [
  { value: "==", label: "==" },
  { value: "!=", label: "!=" },
  { value: "<", label: "<" },
  { value: ">", label: ">" },
  { value: "<=", label: "<=" },
  { value: ">=", label: ">=" },
];

const NUMERIC_FIELDS: ReadonlySet<FilterField> = new Set(["width", "height"]);

interface FilterBuilderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Read the recently-used filters from localStorage. Defensive — on any
 * parse error returns an empty list rather than crashing the dialog.
 */
function loadRecent(): FilterGroup[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is FilterGroup =>
        x &&
        typeof x === "object" &&
        Array.isArray((x as FilterGroup).rules) &&
        ((x as FilterGroup).combinator === "AND" ||
          (x as FilterGroup).combinator === "OR"),
    );
  } catch {
    return [];
  }
}

function saveRecent(filter: FilterGroup): void {
  try {
    const existing = loadRecent();
    // Skip the entry if it's structurally identical to the head — avoids
    // duplicate adjacent entries when the user submits the same filter
    // twice in a row.
    const serialized = JSON.stringify(filter);
    const filtered = existing.filter((f) => JSON.stringify(f) !== serialized);
    const next = [filter, ...filtered].slice(0, RECENT_CAP);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* localStorage may be disabled — silently no-op */
  }
}

/**
 * Truncate a filter tree to a short, human-readable summary for the
 * recently-used dropdown. Walks the tree top-to-bottom and concatenates
 * the first N rule values.
 */
function summarizeFilter(filter: FilterGroup, maxRules = 3): string {
  const parts: string[] = [];
  function walk(g: FilterGroup): void {
    for (const child of g.rules) {
      if (parts.length >= maxRules) return;
      if (isFilterGroup(child)) {
        walk(child);
      } else {
        if (
          child.value === "" ||
          child.value === null ||
          child.value === undefined
        ) {
          continue;
        }
        const not = child.not ? "!" : "";
        parts.push(`${not}${child.field}${child.op}${child.value}`);
      }
    }
  }
  walk(filter);
  if (parts.length === 0) return "(empty)";
  return parts.join(", ");
}

/**
 * Update one node within the tree by a deep path of indexes. Returns a
 * new tree (immutable) — see common/coding-style.md immutability rule.
 */
function updateAtPath(
  group: FilterGroup,
  path: number[],
  updater: (node: FilterRule | FilterGroup) => FilterRule | FilterGroup,
): FilterGroup {
  if (path.length === 0) {
    const next = updater(group);
    if (isFilterGroup(next)) return next;
    return { combinator: group.combinator, rules: [next] };
  }
  const [head, ...tail] = path;
  const nextRules = group.rules.map((child, i) => {
    if (i !== head) return child;
    if (tail.length === 0) return updater(child);
    if (isFilterGroup(child)) return updateAtPath(child, tail, updater);
    return child;
  });
  return { ...group, rules: nextRules };
}

/** Insert a child at the end of the group at `path`. */
function appendAtPath(
  group: FilterGroup,
  path: number[],
  child: FilterRule | FilterGroup,
): FilterGroup {
  if (path.length === 0) {
    return { ...group, rules: [...group.rules, child] };
  }
  const [head, ...tail] = path;
  const nextRules = group.rules.map((node, i) => {
    if (i !== head) return node;
    if (isFilterGroup(node)) return appendAtPath(node, tail, child);
    return node;
  });
  return { ...group, rules: nextRules };
}

/** Remove the child at the leaf of `path`. */
function removeAtPath(group: FilterGroup, path: number[]): FilterGroup {
  if (path.length === 0) return group; // can't remove the root
  if (path.length === 1) {
    const [idx] = path;
    return {
      ...group,
      rules: group.rules.filter((_, i) => i !== idx),
    };
  }
  const [head, ...tail] = path;
  const nextRules = group.rules.map((node, i) => {
    if (i !== head) return node;
    if (isFilterGroup(node)) return removeAtPath(node, tail);
    return node;
  });
  return { ...group, rules: nextRules };
}

interface RuleRowProps {
  rule: FilterRule;
  path: number[];
  onChange: (path: number[], next: FilterRule) => void;
  onRemove: (path: number[]) => void;
}

function RuleRow({ rule, path, onChange, onRemove }: RuleRowProps) {
  const isNumeric = NUMERIC_FIELDS.has(rule.field);
  const valueAsString =
    typeof rule.value === "number" ? String(rule.value) : (rule.value ?? "");

  return (
    <div
      data-testid="filter-rule-row"
      className="flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--bg-app)] border border-[var(--border-subtle)] px-2 py-1.5"
    >
      <button
        type="button"
        onClick={() => onChange(path, { ...rule, not: !rule.not })}
        aria-label="Toggle NOT"
        aria-pressed={rule.not}
        data-testid="filter-rule-not"
        className={cn(
          "inline-flex h-7 min-w-[36px] items-center justify-center rounded-[var(--radius-sm)] px-2",
          "text-[11px] font-medium tracking-tight uppercase",
          "border transition-colors",
          rule.not
            ? "bg-[var(--danger-bg)] border-[var(--danger)] text-[color:var(--danger)]"
            : "bg-transparent border-[var(--border-subtle)] text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)] hover:border-[var(--border-strong)]",
        )}
      >
        Not
      </button>

      <Select
        value={rule.field}
        onValueChange={(v) => {
          const nextField = v as FilterField;
          // When swapping from numeric → string (or vice versa), reset
          // the value so the input control matches the field's type.
          const wasNumeric = NUMERIC_FIELDS.has(rule.field);
          const isNowNumeric = NUMERIC_FIELDS.has(nextField);
          const nextValue = wasNumeric === isNowNumeric ? rule.value : "";
          onChange(path, { ...rule, field: nextField, value: nextValue });
        }}
      >
        <Select.Trigger aria-label="Field" data-testid="filter-rule-field">
          <Select.Value />
        </Select.Trigger>
        <Select.Content>
          {FIELD_OPTIONS.map((o) => (
            <Select.Item key={o.value} value={o.value}>
              {o.label}
            </Select.Item>
          ))}
        </Select.Content>
      </Select>

      <Select
        value={rule.op}
        onValueChange={(v) => onChange(path, { ...rule, op: v as FilterOp })}
      >
        <Select.Trigger
          aria-label="Operator"
          data-testid="filter-rule-op"
          className="w-[68px]"
        >
          <Select.Value />
        </Select.Trigger>
        <Select.Content>
          {OP_OPTIONS.map((o) => (
            <Select.Item key={o.value} value={o.value}>
              {o.label}
            </Select.Item>
          ))}
        </Select.Content>
      </Select>

      <Input
        aria-label="Value"
        data-testid="filter-rule-value"
        type={isNumeric ? "number" : "text"}
        value={valueAsString}
        placeholder={isNumeric ? "0" : "value"}
        onChange={(e) => {
          const v = e.target.value;
          const next: FilterRule = {
            ...rule,
            value: isNumeric && v !== "" ? Number(v) : v,
          };
          onChange(path, next);
        }}
        className="h-7 flex-1 min-w-0 text-[12px]"
      />

      <button
        type="button"
        onClick={() => onRemove(path)}
        aria-label="Remove rule"
        data-testid="filter-rule-remove"
        className="grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] text-[color:var(--text-tertiary)] hover:bg-[oklch(0.70_0.20_25_/_0.10)] hover:text-[color:var(--danger)] transition-colors"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

interface GroupSectionProps {
  group: FilterGroup;
  path: number[];
  depth: number;
  onUpdate: (
    path: number[],
    updater: (node: FilterRule | FilterGroup) => FilterRule | FilterGroup,
  ) => void;
  onAppend: (path: number[], child: FilterRule | FilterGroup) => void;
  onRemove: (path: number[]) => void;
  onRuleChange: (path: number[], next: FilterRule) => void;
}

function GroupSection({
  group,
  path,
  depth,
  onUpdate,
  onAppend,
  onRemove,
  onRuleChange,
}: GroupSectionProps) {
  const isRoot = depth === 0;
  return (
    <fieldset
      data-testid="filter-group"
      className={cn(
        "grid gap-2 rounded-[var(--radius-md)] border p-2",
        isRoot
          ? "border-[var(--glass-border)] bg-[var(--glass-bg-subtle)]"
          : "border-[var(--border-strong)] bg-[var(--bg-app)] ml-2",
      )}
    >
      <header className="flex items-center justify-between">
        <div
          role="group"
          aria-label="Combinator"
          className="inline-flex h-6 items-center rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-app)] p-0.5"
        >
          {(["AND", "OR"] as const).map((c) => {
            const active = group.combinator === c;
            return (
              <button
                key={c}
                type="button"
                onClick={() =>
                  onUpdate(path, (node) =>
                    isFilterGroup(node) ? { ...node, combinator: c } : node,
                  )
                }
                aria-pressed={active}
                data-testid={`filter-group-combinator-${c}`}
                className={cn(
                  "h-5 px-2 text-[11px] font-medium tracking-tight uppercase rounded-[var(--radius-sm)] transition-colors",
                  active
                    ? "bg-[var(--accent)] text-[color:var(--accent-fg)]"
                    : "text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)]",
                )}
              >
                {c}
              </button>
            );
          })}
        </div>
        {!isRoot && (
          <button
            type="button"
            onClick={() => onRemove(path)}
            aria-label="Remove group"
            data-testid="filter-group-remove"
            className="grid h-6 w-6 place-items-center rounded-[var(--radius-sm)] text-[color:var(--text-tertiary)] hover:bg-[oklch(0.70_0.20_25_/_0.10)] hover:text-[color:var(--danger)] transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </header>

      <div className="grid gap-1.5">
        {group.rules.map((child, i) => {
          const childPath = [...path, i];
          if (isFilterGroup(child)) {
            return (
              <GroupSection
                key={`g-${i}`}
                group={child}
                path={childPath}
                depth={depth + 1}
                onUpdate={onUpdate}
                onAppend={onAppend}
                onRemove={onRemove}
                onRuleChange={onRuleChange}
              />
            );
          }
          return (
            <RuleRow
              key={`r-${i}`}
              rule={child}
              path={childPath}
              onChange={onRuleChange}
              onRemove={onRemove}
            />
          );
        })}
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          data-testid="filter-add-rule"
          onClick={() => onAppend(path, makeEmptyRule())}
          className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-sm)] border border-dashed border-[var(--border-subtle)] bg-transparent px-2.5 text-[12px] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)] transition-colors"
        >
          <Plus className="h-3 w-3" />
          Add rule
        </button>
        <button
          type="button"
          data-testid="filter-add-group"
          onClick={() => onAppend(path, makeEmptyGroup())}
          className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-sm)] border border-dashed border-[var(--border-subtle)] bg-transparent px-2.5 text-[12px] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)] transition-colors"
        >
          <Plus className="h-3 w-3" />
          Add group
        </button>
      </div>
    </fieldset>
  );
}

export function FilterBuilderDialog({
  open,
  onOpenChange,
}: FilterBuilderDialogProps) {
  const setFilter = useFilter((s) => s.setFilter);
  const clearFilter = useFilter((s) => s.clearFilter);
  const activeFilter = useFilter((s) => s.filter);

  const [tree, setTree] = useState<FilterGroup>(() => makeEmptyGroup());
  const [recent, setRecent] = useState<FilterGroup[]>(() => loadRecent());

  // Re-seed the working tree whenever the dialog opens. Pulls the
  // currently-applied filter back into the editor so the user sees
  // their last submission and can tweak it.
  useEffect(() => {
    if (!open) return;
    setTree(activeFilter ?? makeEmptyGroup());
    setRecent(loadRecent());
  }, [open, activeFilter]);

  const handleRuleChange = useCallback(
    (path: number[], next: FilterRule) => {
      setTree((cur) => updateAtPath(cur, path, () => next));
    },
    [],
  );

  const handleUpdate = useCallback(
    (
      path: number[],
      updater: (node: FilterRule | FilterGroup) => FilterRule | FilterGroup,
    ) => {
      setTree((cur) => updateAtPath(cur, path, updater));
    },
    [],
  );

  const handleAppend = useCallback(
    (path: number[], child: FilterRule | FilterGroup) => {
      setTree((cur) => appendAtPath(cur, path, child));
    },
    [],
  );

  const handleRemove = useCallback((path: number[]) => {
    setTree((cur) => removeAtPath(cur, path));
  }, []);

  const handleClear = useCallback(() => {
    setTree(makeEmptyGroup());
  }, []);

  const handleCancel = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const handleSubmit = useCallback(() => {
    // Empty tree → clear the filter so the canvas / Objects panel show
    // every annotation again. Saves the user a round-trip through Clear.
    const meaningful = countMeaningfulRules(tree) > 0;
    if (!meaningful) {
      clearFilter();
    } else {
      setFilter(tree);
      saveRecent(tree);
      setRecent(loadRecent());
    }
    onOpenChange(false);
  }, [tree, setFilter, clearFilter, onOpenChange]);

  const handleLoadRecent = useCallback((preset: FilterGroup) => {
    setTree(preset);
  }, []);

  const recentLabel = useMemo(() => "Recently used", []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(94vw,640px)]">
        <DialogHeader>
          <DialogTitle>Filter annotations</DialogTitle>
        </DialogHeader>

        <div className="grid gap-3">
          {recent.length > 0 && (
            <div className="flex items-center justify-between gap-2">
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    data-testid="filter-recent-trigger"
                    className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--glass-border)] bg-[var(--glass-bg-subtle)] px-2.5 text-[12px] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)] transition-colors"
                  >
                    {recentLabel}
                    <ChevronDown className="h-3 w-3" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="start"
                    sideOffset={4}
                    // DESIGN.md §1 / §6 — solid surface, compact 6px radius.
                    className={cn(
                      "z-[902] min-w-[260px] max-w-[400px] rounded-[var(--radius-6)] p-1",
                      "bg-[var(--bg-elev)] border border-[var(--border-subtle)]",
                      "shadow-[var(--shadow-card)]",
                    )}
                  >
                    {recent.map((preset, i) => (
                      <DropdownMenu.Item
                        key={i}
                        onSelect={() => handleLoadRecent(preset)}
                        data-testid={`filter-recent-item-${i}`}
                        className="cursor-pointer rounded-[var(--radius-sm)] px-2 py-1.5 text-[12px] text-[color:var(--text-secondary)] outline-none data-[highlighted]:bg-[var(--bg-hover)] data-[highlighted]:text-[color:var(--text-primary)]"
                      >
                        <span className="font-mono-data block truncate">
                          {summarizeFilter(preset)}
                        </span>
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          )}

          <GroupSection
            group={tree}
            path={[]}
            depth={0}
            onUpdate={handleUpdate}
            onAppend={handleAppend}
            onRemove={handleRemove}
            onRuleChange={handleRuleChange}
          />
        </div>

        <DialogFooter className="justify-between">
          <Button
            type="button"
            variant="danger"
            size="sm"
            onClick={handleClear}
            data-testid="filter-clear"
          >
            Clear filters
          </Button>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleCancel}
              data-testid="filter-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={handleSubmit}
              data-testid="filter-submit"
            >
              Submit
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Recursive count of rules with non-empty values. */
function countMeaningfulRules(group: FilterGroup): number {
  let n = 0;
  for (const child of group.rules) {
    if (isFilterGroup(child)) {
      n += countMeaningfulRules(child);
    } else if (
      child.value !== "" &&
      child.value !== null &&
      child.value !== undefined
    ) {
      n += 1;
    }
  }
  return n;
}
