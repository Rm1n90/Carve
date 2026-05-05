// Armin Mehri — mehri.armin@gmail.com
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Cpu,
  HardDrive,
  MemoryStick,
  Server,
  Sparkles,
  Thermometer,
  Zap,
} from "lucide-react";
import { Badge, Card } from "@/components/ui";
import {
  systemApi,
  type SystemCPUInfo,
  type SystemDiskPartition,
  type SystemGPUInfo,
  type SystemInfo,
  type SystemMemoryInfo,
  type SystemOSInfo,
} from "@/api/system";

// ---------------------------- Helpers ----------------------------

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const TB = GB * 1024;

function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= TB) return `${(bytes / TB).toFixed(fractionDigits)} TB`;
  if (bytes >= GB) return `${(bytes / GB).toFixed(fractionDigits)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(fractionDigits)} MB`;
  if (bytes >= KB) return `${(bytes / KB).toFixed(fractionDigits)} KB`;
  return `${bytes} B`;
}

function formatGB(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0.0 GB";
  return `${(bytes / GB).toFixed(fractionDigits)} GB`;
}

function formatMB(mb: number, fractionDigits = 0): string {
  if (!Number.isFinite(mb) || mb <= 0) return "0 MB";
  if (mb >= 1024) return `${(mb / 1024).toFixed(fractionDigits || 1)} GB`;
  return `${mb.toFixed(fractionDigits)} MB`;
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatRelative(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "just now";
  const deltaSec = Math.max(0, Math.round((nowMs - t) / 1000));
  if (deltaSec < 5) return "just now";
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const m = Math.floor(deltaSec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

function thresholdColor(percent: number): string {
  if (percent >= 80) return "var(--danger)";
  if (percent >= 50) return "var(--warning)";
  return "var(--success)";
}

function clampPercent(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(100, p));
}

// ---------------------------- Reusable bits ----------------------------

interface SectionLabelProps {
  children: React.ReactNode;
}

function SectionLabel({ children }: SectionLabelProps) {
  return (
    <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-[color:var(--text-tertiary)]">
      {children}
    </span>
  );
}

interface StatProps {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
}

function Stat({ label, value, hint }: StatProps) {
  return (
    <div className="grid gap-0.5 min-w-0">
      <span className="text-[11.5px] text-[color:var(--text-tertiary)]">{label}</span>
      <span className="text-[14px] font-medium text-[color:var(--text-primary)] tabular-nums truncate">
        {value}
      </span>
      {hint ? (
        <span className="text-[11px] text-[color:var(--text-tertiary)] tabular-nums">{hint}</span>
      ) : null}
    </div>
  );
}

interface BarProps {
  percent: number;
  height?: number;
  ariaLabel?: string;
}

function Bar({ percent, height = 4, ariaLabel }: BarProps) {
  const value = clampPercent(percent);
  const color = thresholdColor(value);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      aria-label={ariaLabel}
      className="w-full overflow-hidden rounded-full bg-[var(--bg-subtle)]"
      style={{ height }}
    >
      <div
        className="h-full rounded-full"
        style={{
          width: `${value}%`,
          backgroundColor: color,
          transition: "width 600ms ease, background-color 200ms ease",
        }}
      />
    </div>
  );
}

interface BigStatProps {
  primary: React.ReactNode;
  secondary?: React.ReactNode;
}

function BigStat({ primary, secondary }: BigStatProps) {
  return (
    <div className="grid gap-1.5">
      <span className="font-editorial text-[28px] leading-none text-[color:var(--text-primary)] tabular-nums">
        {primary}
      </span>
      {secondary ? (
        <span className="text-[12px] text-[color:var(--text-tertiary)] tabular-nums">
          {secondary}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------- Sub-cards ----------------------------

function OsCard({ os }: { os: SystemOSInfo }) {
  return (
    <Card variant="surface" radius="lg" className="p-6">
      <div className="flex items-start gap-5">
        <div
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-subtle)] text-[color:var(--accent)]"
          aria-hidden
        >
          <Server className="h-5 w-5" />
        </div>
        <div className="grid gap-3 flex-1 min-w-0">
          <div className="grid gap-1">
            <SectionLabel>Host</SectionLabel>
            <h2 className="font-editorial text-[22px] leading-tight text-[color:var(--text-primary)] truncate">
              {os.hostname}
            </h2>
            <span className="text-[12.5px] text-[color:var(--text-secondary)] truncate">
              {os.distro ?? os.name}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3">
            <Stat label="Kernel" value={os.name} />
            <Stat label="Architecture" value={os.architecture || "—"} />
            <Stat label="Python" value={os.python_version} />
            <Stat label="Uptime" value={formatUptime(os.uptime_seconds)} />
          </div>
        </div>
      </div>
    </Card>
  );
}

function CpuCard({ cpu }: { cpu: SystemCPUInfo }) {
  const cores = cpu.per_core_percent;
  const ghz = (mhz: number | null): string => (mhz ? `${(mhz / 1000).toFixed(2)} GHz` : "—");

  // Cap visible columns at 16 so very large CPUs wrap into multiple rows
  // instead of producing slivers.
  const cols = Math.min(cores.length || 1, 16);

  return (
    <Card variant="surface" radius="lg" className="p-6 grid gap-5">
      <div className="flex items-start justify-between gap-4">
        <div className="grid gap-1 min-w-0">
          <SectionLabel>CPU</SectionLabel>
          <h2 className="text-[14.5px] font-medium text-[color:var(--text-primary)] truncate">
            {cpu.model ?? "Unknown CPU"}
          </h2>
        </div>
        <Cpu className="h-5 w-5 text-[color:var(--text-tertiary)]" aria-hidden />
      </div>

      <div className="grid gap-2">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <BigStat primary={`${cpu.load_percent.toFixed(0)}%`} secondary="Overall load" />
          <span className="text-[11.5px] text-[color:var(--text-tertiary)] tabular-nums">
            {cpu.physical_cores} cores · {cpu.logical_cores} threads
          </span>
        </div>
        <Bar percent={cpu.load_percent} height={6} ariaLabel="Overall CPU load" />
      </div>

      {cores.length > 0 ? (
        <div className="grid gap-2">
          <SectionLabel>Per-thread</SectionLabel>
          <div
            className="grid gap-1.5"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          >
            {cores.map((p, i) => (
              <div key={i} className="grid gap-1" title={`Thread ${i}: ${p.toFixed(0)}%`}>
                <div
                  className="h-12 w-full overflow-hidden rounded-[3px] bg-[var(--bg-subtle)] flex flex-col justify-end"
                  aria-label={`Thread ${i} ${p.toFixed(0)}%`}
                >
                  <div
                    style={{
                      height: `${clampPercent(p)}%`,
                      backgroundColor: thresholdColor(p),
                      transition: "height 600ms ease, background-color 200ms ease",
                    }}
                  />
                </div>
                <span className="text-[9.5px] text-center text-[color:var(--text-tertiary)] tabular-nums">
                  {p.toFixed(0)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3 pt-1">
        <Stat label="Physical cores" value={cpu.physical_cores} />
        <Stat label="Logical threads" value={cpu.logical_cores} />
        <Stat label="Current freq" value={ghz(cpu.frequency_mhz_current)} />
        <Stat
          label="Min · Max"
          value={`${ghz(cpu.frequency_mhz_min)} · ${ghz(cpu.frequency_mhz_max)}`}
        />
      </div>
    </Card>
  );
}

function MemoryCard({ mem }: { mem: SystemMemoryInfo }) {
  const swapPresent = mem.swap_total_bytes > 0;
  return (
    <Card variant="surface" radius="lg" className="p-6 grid gap-5">
      <div className="flex items-start justify-between gap-4">
        <div className="grid gap-1">
          <SectionLabel>Memory</SectionLabel>
          <h2 className="text-[14.5px] font-medium text-[color:var(--text-primary)]">RAM</h2>
        </div>
        <MemoryStick className="h-5 w-5 text-[color:var(--text-tertiary)]" aria-hidden />
      </div>

      <div className="grid gap-2">
        <BigStat
          primary={
            <>
              {formatGB(mem.used_bytes)}{" "}
              <span className="text-[color:var(--text-tertiary)]">/</span>{" "}
              {formatGB(mem.total_bytes)}
            </>
          }
          secondary={`${mem.percent.toFixed(0)}% used`}
        />
        <Bar percent={mem.percent} height={6} ariaLabel="RAM usage" />
      </div>

      <div className="grid grid-cols-3 gap-x-6 gap-y-2">
        <Stat label="Available" value={formatGB(mem.available_bytes)} />
        <Stat label="Free" value={formatGB(mem.free_bytes)} />
        <Stat label="Used" value={formatGB(mem.used_bytes)} />
      </div>

      {swapPresent ? (
        <div className="grid gap-2 pt-2 border-t border-[var(--border-subtle)]">
          <div className="flex items-center justify-between">
            <SectionLabel>Swap</SectionLabel>
            <span className="text-[11.5px] text-[color:var(--text-tertiary)] tabular-nums">
              {formatGB(mem.swap_used_bytes)} / {formatGB(mem.swap_total_bytes)} ·{" "}
              {mem.swap_percent.toFixed(0)}%
            </span>
          </div>
          <Bar percent={mem.swap_percent} ariaLabel="Swap usage" />
        </div>
      ) : (
        <span className="text-[11px] text-[color:var(--text-tertiary)]">No swap configured</span>
      )}
    </Card>
  );
}

function GpuCard({ gpu }: { gpu: SystemGPUInfo }) {
  return (
    <Card variant="surface" radius="lg" className="p-6 grid gap-5">
      <div className="flex items-start justify-between gap-4">
        <div className="grid gap-1 min-w-0">
          <SectionLabel>GPU {gpu.index}</SectionLabel>
          <h2 className="text-[14.5px] font-medium text-[color:var(--text-primary)] truncate">
            {gpu.name}
          </h2>
          {gpu.driver_version ? (
            <span className="font-mono text-[10.5px] tracking-tight text-[color:var(--text-tertiary)]">
              Driver {gpu.driver_version}
            </span>
          ) : null}
        </div>
        <Sparkles className="h-5 w-5 text-[color:var(--text-tertiary)]" aria-hidden />
      </div>

      <div className="grid gap-2">
        <BigStat
          primary={
            <>
              {formatMB(gpu.memory_used_mb)}{" "}
              <span className="text-[color:var(--text-tertiary)]">/</span>{" "}
              {formatMB(gpu.memory_total_mb)}
            </>
          }
          secondary={`${gpu.memory_percent.toFixed(0)}% VRAM`}
        />
        <Bar percent={gpu.memory_percent} height={6} ariaLabel="GPU memory" />
      </div>

      <div className="grid grid-cols-3 gap-x-6 gap-y-2">
        <Stat label="Free VRAM" value={formatMB(gpu.memory_free_mb)} />
        <Stat
          label="Utilisation"
          value={
            gpu.utilization_percent !== null
              ? `${gpu.utilization_percent.toFixed(0)}%`
              : "—"
          }
        />
        <Stat
          label="Temperature"
          value={
            <span className="inline-flex items-center gap-1">
              <Thermometer className="h-3.5 w-3.5 text-[color:var(--text-tertiary)]" aria-hidden />
              {gpu.temperature_c !== null ? `${gpu.temperature_c.toFixed(0)}°C` : "—"}
            </span>
          }
        />
      </div>
    </Card>
  );
}

function NoGpuCard() {
  return (
    <Card variant="surface" radius="lg" className="p-6 grid gap-3">
      <div className="flex items-start gap-3">
        <Zap className="h-5 w-5 text-[color:var(--text-tertiary)]" aria-hidden />
        <div className="grid gap-1">
          <SectionLabel>GPU</SectionLabel>
          <h2 className="text-[14.5px] font-medium text-[color:var(--text-primary)]">
            No GPU detected
          </h2>
          <p className="text-[12.5px] text-[color:var(--text-secondary)] max-w-[52ch]">
            The API container couldn't reach <code className="font-mono">nvidia-smi</code>.
            If you do have a GPU on the host, make sure the container exposes the
            NVIDIA runtime (e.g. <code className="font-mono">--gpus all</code> or
            the <code className="font-mono">nvidia</code> Compose runtime).
          </p>
        </div>
      </div>
    </Card>
  );
}

function StorageCard({ disks }: { disks: SystemDiskPartition[] }) {
  if (disks.length === 0) {
    return (
      <Card variant="surface" radius="lg" className="p-6">
        <SectionLabel>Storage</SectionLabel>
        <p className="text-[12.5px] text-[color:var(--text-secondary)] mt-2">
          No mounted partitions reported.
        </p>
      </Card>
    );
  }

  return (
    <Card variant="surface" radius="lg" className="p-6 grid gap-5">
      <div className="flex items-start justify-between gap-4">
        <div className="grid gap-1">
          <SectionLabel>Storage</SectionLabel>
          <h2 className="text-[14.5px] font-medium text-[color:var(--text-primary)]">
            Mounted volumes
          </h2>
        </div>
        <HardDrive className="h-5 w-5 text-[color:var(--text-tertiary)]" aria-hidden />
      </div>

      <div className="grid gap-4">
        {disks.map((d) => (
          <div key={d.mountpoint} className="grid gap-1.5">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-[12.5px] text-[color:var(--text-primary)] truncate">
                  {d.mountpoint}
                </span>
                {d.fstype ? (
                  <Badge variant="neutral" size="sm">
                    {d.fstype}
                  </Badge>
                ) : null}
              </div>
              <span className="text-[11.5px] text-[color:var(--text-tertiary)] tabular-nums shrink-0">
                {formatBytes(d.used_bytes)} / {formatBytes(d.total_bytes)} ·{" "}
                <span className="font-medium" style={{ color: thresholdColor(d.percent) }}>
                  {d.percent.toFixed(0)}%
                </span>
              </span>
            </div>
            <Bar percent={d.percent} ariaLabel={`Storage ${d.mountpoint}`} />
            <span className="text-[10.5px] text-[color:var(--text-tertiary)] tabular-nums">
              {formatBytes(d.free_bytes)} free
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------- Skeleton ----------------------------

function SkeletonBar({ height = 6 }: { height?: number }) {
  return (
    <div
      className="w-full rounded-full bg-[var(--bg-subtle)] animate-pulse"
      style={{ height }}
    />
  );
}

function SkeletonCard({ className = "" }: { className?: string }) {
  return (
    <Card variant="surface" radius="lg" className={`p-6 grid gap-4 ${className}`}>
      <div className="h-3 w-24 rounded bg-[var(--bg-subtle)] animate-pulse" />
      <div className="h-7 w-40 rounded bg-[var(--bg-subtle)] animate-pulse" />
      <SkeletonBar />
      <div className="grid grid-cols-3 gap-3">
        <div className="h-3 rounded bg-[var(--bg-subtle)] animate-pulse" />
        <div className="h-3 rounded bg-[var(--bg-subtle)] animate-pulse" />
        <div className="h-3 rounded bg-[var(--bg-subtle)] animate-pulse" />
      </div>
    </Card>
  );
}

// ---------------------------- Page ----------------------------

export function SystemPage() {
  const query = useQuery<SystemInfo>({
    queryKey: ["system", "info"],
    queryFn: systemApi.info,
    refetchInterval: 5000,
    refetchOnWindowFocus: false,
  });

  // Tick every second so the relative "Updated Xs ago" feels live without
  // burning a whole refetch cycle.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const data = query.data;

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-8 grid gap-6">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div className="grid gap-1.5">
          <SectionLabel>System</SectionLabel>
          <h1 className="font-editorial text-[40px] leading-[0.95] tracking-[-0.01em] text-[color:var(--text-primary)]">
            System monitor
          </h1>
          <p className="text-[13px] text-[color:var(--text-secondary)] max-w-[60ch]">
            Live OS, CPU, GPU, memory, and storage metrics for the host running
            this Carve API instance.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11.5px] text-[color:var(--text-tertiary)]">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{
              backgroundColor: query.isFetching ? "var(--accent)" : "var(--success)",
              transition: "background-color 200ms ease",
            }}
            aria-hidden
          />
          <Activity className="h-3.5 w-3.5" aria-hidden />
          <span className="tabular-nums">
            {data
              ? `Updated ${formatRelative(data.collected_at, now)}`
              : query.isError
                ? "Update failed"
                : "Loading…"}
          </span>
        </div>
      </header>

      {query.isError ? (
        <Card
          variant="surface"
          radius="lg"
          className="p-8 grid gap-3 place-items-center text-center"
        >
          <AlertTriangle className="h-6 w-6 text-[color:var(--danger)]" aria-hidden />
          <h2 className="font-editorial text-[20px] text-[color:var(--text-primary)]">
            Couldn't load system metrics
          </h2>
          <p className="text-[12.5px] text-[color:var(--text-secondary)] max-w-[48ch]">
            {(query.error as Error)?.message ??
              "The API didn't respond. Check that the api container is healthy and that you're authenticated."}
          </p>
          <button
            type="button"
            onClick={() => query.refetch()}
            className="mt-2 inline-flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] px-3 py-1.5 text-[12.5px] font-medium text-[color:var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            Retry
          </button>
        </Card>
      ) : null}

      {!data && !query.isError ? (
        <div className="grid gap-6">
          <SkeletonCard />
          <SkeletonCard />
          <div className="grid gap-6 lg:grid-cols-2">
            <SkeletonCard />
            <SkeletonCard />
          </div>
          <SkeletonCard />
        </div>
      ) : null}

      {data ? (
        <div className="grid gap-6">
          <OsCard os={data.os} />
          <CpuCard cpu={data.cpu} />

          <div className="grid gap-6 lg:grid-cols-2">
            <MemoryCard mem={data.memory} />
            {data.gpus.length > 0 ? (
              <div className="grid gap-6">
                {data.gpus.map((gpu) => (
                  <GpuCard key={gpu.index} gpu={gpu} />
                ))}
              </div>
            ) : (
              <NoGpuCard />
            )}
          </div>

          <StorageCard disks={data.disks} />
        </div>
      ) : null}
    </div>
  );
}
