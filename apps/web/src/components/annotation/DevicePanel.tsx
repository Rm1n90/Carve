// Armin Mehri — mehri.armin@gmail.com
/**
 * Compute device picker (v3.25).
 *
 * Surfaces every device the model service can see (CUDA + MPS + CPU)
 * with live free/total memory, then offers a per-model preference:
 *   - "Auto" (default) — model service picks best at request time.
 *   - Specific device id — validated against the live probe.
 *
 * Smart guardrails:
 *   - Disables device options that don't have enough free VRAM for the
 *     selected model (per-kind threshold returned by the API).
 *   - When the user submits a pick that the server can't honour
 *     (OOM / unavailable / missing), we surface the server's
 *     ``reason`` text in a warning toast and revert the dropdown to
 *     the recommended fallback. The user always knows what we did
 *     and why.
 *   - The SAM model is loaded once with a baked-in device. Switching
 *     SAM device exposes a "Reload" action so the user can apply the
 *     new pref (1–3s, drops + reloads with new device).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, RefreshCw } from "lucide-react";
import { useState } from "react";

import {
  devicesApi,
  type DeviceInfo,
  type DevicesStatus,
  type ModelDeviceStatus,
  type ModelKind,
} from "@/api/devices";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/cn";
import { showToast } from "@/lib/toast";

const MODEL_LABELS: Record<ModelKind, string> = {
  sam: "SAM (interactive segmentation)",
  yoloe: "YOLOE (Smart Find — text / visual / prompt-free)",
  yolo: "YOLO (custom uploaded weights)",
};

function formatMb(mb: number): string {
  if (mb <= 0) return "—";
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

function deviceLabel(d: DeviceInfo): string {
  if (d.kind === "cpu") return d.name;
  const mem =
    d.total_mb > 0
      ? ` · ${formatMb(d.free_mb)} free / ${formatMb(d.total_mb)}`
      : "";
  return `${d.name} (${d.id})${mem}`;
}

function isDeviceFeasible(d: DeviceInfo, minFreeMb: number): boolean {
  if (d.kind === "cpu") return true;
  if (d.kind === "mps" && d.total_mb === 0) return true; // memory unknown — allow
  return d.free_mb >= minFreeMb;
}

interface ModelRowProps {
  status: ModelDeviceStatus;
  devices: DeviceInfo[];
  minFreeMb: number;
  onChange: (kind: ModelKind, value: string) => void;
  reloadingSam: boolean;
  onSamReload?: () => void;
}

function ModelRow({
  status,
  devices,
  minFreeMb,
  onChange,
  reloadingSam,
  onSamReload,
}: ModelRowProps) {
  const { kind, preference, resolution } = status;
  const effective = resolution.device;
  const fallbackUsed = resolution.fallback_used;

  const options: {
    value: string;
    label: string;
    disabled: boolean;
    hint?: string;
  }[] = [
    {
      value: "auto",
      label: `Auto (recommended: ${resolution.recommended})`,
      disabled: false,
    },
  ];
  for (const d of devices) {
    const feasible = isDeviceFeasible(d, minFreeMb);
    options.push({
      value: d.id,
      label: deviceLabel(d),
      disabled: !feasible,
      hint: feasible
        ? undefined
        : `Needs ≥ ${formatMb(minFreeMb)} free; this device has ${formatMb(d.free_mb)}.`,
    });
  }

  return (
    <div
      data-testid={`device-row-${kind}`}
      className="grid gap-2 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-app)] p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="grid gap-0.5">
          <div className="text-[12.5px] font-medium tracking-tight text-[color:var(--text-primary)]">
            {MODEL_LABELS[kind]}
          </div>
          <div className="text-[11px] text-[color:var(--text-tertiary)]">
            Effective: <span className="font-mono">{effective}</span>
            {fallbackUsed && (
              <span className="ml-1 text-[color:var(--warning)]">
                (fell back from {resolution.requested})
              </span>
            )}
            {" · "}
            Min. free: {formatMb(minFreeMb)}
          </div>
        </div>
        {kind === "sam" && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onSamReload}
            disabled={reloadingSam}
            data-testid="device-sam-reload"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", reloadingSam && "animate-spin")}
            />
            <span className="ml-1.5 text-[12px]">
              {reloadingSam ? "Reloading…" : "Reload"}
            </span>
          </Button>
        )}
      </div>

      <Select value={preference} onValueChange={(v) => onChange(kind, v)}>
        <Select.Trigger
          aria-label={`${kind} device`}
          data-testid={`device-select-${kind}`}
          className="h-8 text-[12.5px]"
        >
          <Select.Value />
        </Select.Trigger>
        <Select.Content>
          {options.map((o) => (
            <Select.Item
              key={o.value}
              value={o.value}
              disabled={o.disabled}
              title={o.hint}
            >
              {o.label}
              {o.disabled && (
                <span className="ml-1 text-[color:var(--text-tertiary)]">
                  · insufficient memory
                </span>
              )}
            </Select.Item>
          ))}
        </Select.Content>
      </Select>

      {fallbackUsed && (
        <p className="text-[10.5px] text-[color:var(--warning)]">
          {resolution.reason}
        </p>
      )}
    </div>
  );
}

export function DevicePanel() {
  const qc = useQueryClient();
  const [reloadingSam, setReloadingSam] = useState(false);

  const statusQ = useQuery<DevicesStatus>({
    queryKey: ["devices", "status"],
    queryFn: () => devicesApi.status(),
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  const setPrefM = useMutation({
    mutationFn: (vars: { kind: ModelKind; device: string }) =>
      devicesApi.setPreference(vars.kind, vars.device),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["devices", "status"] });
      if (data.fallback_used) {
        showToast(data.reason, { variant: "warning", duration: 6000 });
      } else {
        showToast(`${data.kind.toUpperCase()}: ${data.reason}`, {
          variant: "success",
          duration: 3500,
        });
      }
    },
    onError: () => {
      showToast(
        "Couldn't update device preference. Check the model service.",
        { variant: "error", duration: 5000 },
      );
    },
  });

  const samReloadM = useMutation({
    mutationFn: () => devicesApi.samReload(),
    onMutate: () => setReloadingSam(true),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["devices", "status"] });
      showToast(
        data.fallback_used ? data.reason : `SAM ready on ${data.device}.`,
        {
          variant: data.fallback_used ? "warning" : "success",
          duration: 4000,
        },
      );
    },
    onError: () => {
      showToast("SAM reload failed.", { variant: "error", duration: 5000 });
    },
    onSettled: () => setReloadingSam(false),
  });

  if (statusQ.isLoading) {
    return (
      <div
        data-testid="device-panel-loading"
        className="grid place-items-center py-8 text-[12px] text-[color:var(--text-tertiary)]"
      >
        <Cpu className="h-5 w-5 animate-pulse mb-2" />
        Probing devices…
      </div>
    );
  }
  if (statusQ.error || !statusQ.data) {
    return (
      <div
        data-testid="device-panel-error"
        className="grid gap-1 rounded-[var(--radius-sm)] border border-[var(--danger)] bg-[var(--danger-bg)] p-3 text-[12px]"
      >
        <strong>Couldn't reach the model service.</strong>
        <span className="text-[color:var(--text-secondary)]">
          The device picker needs the model container to be running.
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => statusQ.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }

  const { devices, models, recommended, min_free_mb } = statusQ.data;

  return (
    <div data-testid="device-panel" className="grid gap-3">
      <header className="grid gap-1">
        <h3 className="text-[13px] font-medium tracking-tight text-[color:var(--text-primary)]">
          Compute device
        </h3>
        <p className="text-[11px] text-[color:var(--text-tertiary)]">
          Pick where each model runs. <strong>Auto</strong> picks the best
          device for you (currently <code>{recommended}</code>). Devices
          that don't have enough free memory for a model are disabled
          with the reason inline.
        </p>
      </header>

      <section
        aria-label="Detected devices"
        className="grid gap-1 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-app)] p-3"
      >
        <div className="text-[10.5px] uppercase tracking-[0.08em] text-[color:var(--text-tertiary)]">
          Detected on this host
        </div>
        <ul className="grid gap-0.5">
          {devices.map((d) => (
            <li
              key={d.id}
              data-testid={`device-detected-${d.id}`}
              className="flex items-center justify-between text-[12px]"
            >
              <span className="font-mono text-[color:var(--text-secondary)] w-[80px]">
                {d.id}
              </span>
              <span className="flex-1 text-[color:var(--text-primary)] truncate">
                {d.name}
              </span>
              <span className="text-[color:var(--text-tertiary)] font-mono tabular-nums">
                {d.kind === "cpu"
                  ? "—"
                  : d.total_mb > 0
                    ? `${formatMb(d.free_mb)} / ${formatMb(d.total_mb)}`
                    : "memory n/a"}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <div className="grid gap-2">
        {models.map((m) => (
          <ModelRow
            key={m.kind}
            status={m}
            devices={devices}
            minFreeMb={min_free_mb[m.kind] ?? min_free_mb["*"] ?? 512}
            onChange={(kind, value) => setPrefM.mutate({ kind, device: value })}
            reloadingSam={reloadingSam || samReloadM.isPending}
            onSamReload={
              m.kind === "sam" ? () => samReloadM.mutate() : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}
