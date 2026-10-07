// Armin Mehri — mehri.armin@gmail.com
/**
 * Logo AI — what has been spent and what is left.
 *
 * Three figures per provider, each from where it can actually be known:
 *
 *   - what Logo AI runs in this app have cost (the app's own books),
 *   - what the provider itself reports for the whole organization, when
 *     an admin key for its cost report is set on the server,
 *   - the credit left. No provider tells an API client what remains of
 *     a prepaid balance, so an admin copies it from the provider's
 *     billing page once and everything spent after that comes off it.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";

import {
  logoAiApi,
  type LogoAiBilling as Billing,
  type LogoAiProviderBilling,
} from "@/api/logoAi";
import { Button } from "@/components/ui/Button";
import { formatUsd } from "@/components/annotation/LogoAiRuns";
import { showToast } from "@/lib/toast";

interface LogoAiBillingProps {
  taskId: string;
  billing: Billing | undefined;
  failed: boolean;
  onClose: () => void;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Figure({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="grid gap-0.5">
      <span className="text-[10.5px] uppercase tracking-[0.4px] text-[color:var(--text-tertiary)]">
        {label}
      </span>
      <span data-testid={testId} className="text-[13px] font-medium tabular-nums">
        {value}
      </span>
    </div>
  );
}

function ProviderCard({
  taskId,
  row,
  canEdit,
}: {
  taskId: string;
  row: LogoAiProviderBilling;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState("");
  const parsed = Number(amount);
  const valid = amount.trim() !== "" && Number.isFinite(parsed) && parsed >= 0;

  const save = useMutation({
    mutationFn: (value: number | null) => logoAiApi.setCredit(taskId, row.id, value),
    onSuccess: (next: Billing) => {
      qc.setQueryData(["logo-ai", "billing", taskId], next);
      setAmount("");
    },
    onError: (err) => {
      const e = err as { response?: { data?: { message?: string } }; message?: string };
      showToast(`Could not save: ${e?.response?.data?.message ?? e?.message ?? "request failed"}`, {
        variant: "error",
        duration: 7000,
      });
    },
  });

  const credit = row.credit;
  const reported = row.reported;
  const limitLeft =
    reported?.spend_limit_usd != null ? reported.spend_limit_usd - reported.month_usd : null;

  return (
    <section
      data-testid={`logo-ai-billing-${row.id}`}
      className="grid gap-3 p-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)]"
    >
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] font-medium">{row.label}</span>
        {row.billing_url && (
          <a
            href={row.billing_url}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-[color:var(--accent)] hover:underline"
          >
            Billing page <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        )}
      </div>

      <div className="grid gap-1.5">
        {credit ? (
          <>
            <div className="grid grid-cols-3 gap-3">
              <Figure
                label="Credit left"
                value={formatUsd(credit.left_usd)}
                testId={`logo-ai-billing-${row.id}-left`}
              />
              <Figure label="Used since" value={formatUsd(credit.used_usd)} />
              <Figure label="Balance entered" value={formatUsd(credit.amount_usd)} />
            </div>
            <span className="text-[11px] text-[color:var(--text-secondary)]">
              Balance entered {when(credit.as_of)}.{" "}
              {credit.source === "provider"
                ? `${row.label}'s own report shows more spent since then than Logo AI spent here, so something else uses this account too; its figure is used.`
                : "Used is what Logo AI runs here have cost since then."}
            </span>
            {credit.left_usd <= 0 && (
              <span className="text-[11px] text-[color:var(--warning)]">
                By this count the credit is used up. Runs wait when the provider refuses for
                lack of credit and continue by themselves once credit is added.
              </span>
            )}
          </>
        ) : (
          <span className="text-[11px] text-[color:var(--text-secondary)]">
            No balance entered. {row.label} does not tell an API key what is left of a prepaid
            balance: copy it from the billing page once, and what is spent after that is taken
            off it here.
          </span>
        )}
        {canEdit && (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-[color:var(--text-secondary)]">$</span>
            <input
              type="number"
              min={0}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Balance on the billing page now"
              data-testid={`logo-ai-billing-${row.id}-amount`}
              className="h-7 w-[220px] px-2 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)]"
            />
            <Button
              size="sm"
              disabled={!valid || save.isPending}
              onClick={() => save.mutate(parsed)}
              data-testid={`logo-ai-billing-${row.id}-save`}
            >
              {credit ? "Update balance" : "Set balance"}
            </Button>
            {credit && (
              <Button
                variant="ghost"
                size="sm"
                disabled={save.isPending}
                onClick={() => save.mutate(null)}
              >
                Forget
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3 pt-2 border-t border-[var(--border-subtle)]">
        <Figure label="Logo AI · this month" value={formatUsd(row.spent_month_usd)} />
        <Figure label="Logo AI · all time" value={formatUsd(row.spent_total_usd)} />
      </div>

      {row.admin_key_env && (
        <div className="grid gap-1.5 pt-2 border-t border-[var(--border-subtle)]">
          {reported ? (
            <>
              <div className="grid grid-cols-3 gap-3">
                <Figure label={`${row.label} · today`} value={formatUsd(reported.today_usd)} />
                <Figure label={`${row.label} · this month`} value={formatUsd(reported.month_usd)} />
                <Figure
                  label="Monthly spend limit"
                  value={
                    reported.spend_limit_usd != null
                      ? `${formatUsd(reported.spend_limit_usd)}${limitLeft != null ? ` (${formatUsd(Math.max(limitLeft, 0))} left)` : ""}`
                      : "None set"
                  }
                />
              </div>
              <span className="text-[10.5px] text-[color:var(--text-tertiary)]">
                As reported by {row.label} for the whole organization (UTC days, a few minutes
                behind), read {when(reported.fetched_at)}.
              </span>
            </>
          ) : (
            <span className="text-[11px] text-[color:var(--text-secondary)]">
              {row.reported_error ??
                `Set ${row.admin_key_env} on the server (an admin key, read-only use) to also show what ${row.label} itself reports: today, this month and the spend limit.`}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

export function LogoAiBilling({ taskId, billing, failed, onClose }: LogoAiBillingProps) {
  const rows = billing?.providers.filter((p) => p.configured) ?? [];
  return (
    <>
      <div
        data-testid="logo-ai-billing"
        className="grid gap-3 max-h-[calc(88vh-300px)] min-h-[180px] overflow-y-auto pr-2 text-[12px]"
      >
        {!billing ? (
          <span className="text-[color:var(--text-secondary)]">
            {failed ? "Could not load the billing figures." : "Loading…"}
          </span>
        ) : (
          <>
            <span className="text-[11px] text-[color:var(--text-secondary)]">
              Logo AI has cost {formatUsd(billing.task_usd)} on this task. If the provider
              account runs out of credit during a run, the run waits: no image is failed and
              nothing already paid for is lost. It continues by itself once credit is added.
            </span>
            {rows.map((row) => (
              <ProviderCard key={row.id} taskId={taskId} row={row} canEdit={billing.can_edit} />
            ))}
          </>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 pt-3">
        <Button variant="ghost" size="md" onClick={onClose}>
          Close
        </Button>
      </div>
    </>
  );
}
