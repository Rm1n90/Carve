# Armin Mehri — mehri.armin@gmail.com
"""System telemetry endpoint.

Returns a snapshot of OS / CPU / GPU / memory / disk metrics for the
host running the API container. Authenticated, cached for 2 seconds so a
polling UI can refresh on a 5s interval without thrashing psutil.
"""
from __future__ import annotations

import platform
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from threading import Lock

from fastapi import APIRouter, Depends
from pydantic import BaseModel

import psutil

from carve_api.auth.models import User
from carve_api.deps import get_current_admin_user, get_current_user

router = APIRouter(prefix="/system", tags=["system"])

CACHE_TTL_SECONDS = 2.0
NVIDIA_SMI_TIMEOUT_SECONDS = 2.0


# --------------------------------------------------------------------------
# Pydantic response models
# --------------------------------------------------------------------------

class SystemOSInfo(BaseModel):
    name: str
    distro: str | None
    hostname: str
    architecture: str
    python_version: str
    uptime_seconds: int


class SystemCPUInfo(BaseModel):
    model: str | None
    physical_cores: int
    logical_cores: int
    frequency_mhz_current: float | None
    frequency_mhz_min: float | None
    frequency_mhz_max: float | None
    load_percent: float
    per_core_percent: list[float]


class SystemMemoryInfo(BaseModel):
    total_bytes: int
    available_bytes: int
    used_bytes: int
    free_bytes: int
    percent: float
    swap_total_bytes: int
    swap_used_bytes: int
    swap_percent: float


class SystemDiskPartition(BaseModel):
    mountpoint: str
    fstype: str
    total_bytes: int
    used_bytes: int
    free_bytes: int
    percent: float


class SystemGPUInfo(BaseModel):
    index: int
    name: str
    driver_version: str | None
    memory_total_mb: int
    memory_used_mb: int
    memory_free_mb: int
    memory_percent: float
    utilization_percent: float | None
    temperature_c: float | None


class SystemInfo(BaseModel):
    os: SystemOSInfo
    cpu: SystemCPUInfo
    memory: SystemMemoryInfo
    disks: list[SystemDiskPartition]
    gpus: list[SystemGPUInfo]
    collected_at: str


# --------------------------------------------------------------------------
# Collectors
# --------------------------------------------------------------------------

def _read_distro_pretty_name() -> str | None:
    """Parse PRETTY_NAME from /etc/os-release on Linux."""
    if platform.system() != "Linux":
        return None
    try:
        with open("/etc/os-release", "r", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("PRETTY_NAME="):
                    value = line.split("=", 1)[1].strip()
                    if value.startswith('"') and value.endswith('"'):
                        value = value[1:-1]
                    return value or None
    except OSError:
        return None
    return None


def _read_cpu_model() -> str | None:
    """Read CPU model name; falls back to platform.processor()."""
    system = platform.system()
    if system == "Linux":
        try:
            with open("/proc/cpuinfo", "r", encoding="utf-8") as fh:
                for line in fh:
                    if line.lower().startswith("model name"):
                        parts = line.split(":", 1)
                        if len(parts) == 2:
                            value = parts[1].strip()
                            return value or None
        except OSError:
            pass
    proc = platform.processor()
    return proc or None


def _collect_os() -> SystemOSInfo:
    uname = platform.uname()
    name = f"{uname.system} {uname.release}".strip()
    boot = psutil.boot_time()
    uptime = max(0, int(time.time() - boot))
    return SystemOSInfo(
        name=name or platform.platform(),
        distro=_read_distro_pretty_name(),
        hostname=socket.gethostname(),
        architecture=uname.machine or platform.machine(),
        python_version=sys.version.split()[0],
        uptime_seconds=uptime,
    )


def _collect_cpu() -> SystemCPUInfo:
    physical = psutil.cpu_count(logical=False) or 0
    logical = psutil.cpu_count(logical=True) or 0
    freq = None
    try:
        freq = psutil.cpu_freq()
    except Exception:  # noqa: BLE001 — psutil can raise on virtualised hosts
        freq = None
    per_core = psutil.cpu_percent(interval=0.5, percpu=True)
    overall = (sum(per_core) / len(per_core)) if per_core else 0.0
    return SystemCPUInfo(
        model=_read_cpu_model(),
        physical_cores=physical,
        logical_cores=logical,
        frequency_mhz_current=float(freq.current) if freq and freq.current else None,
        frequency_mhz_min=float(freq.min) if freq and freq.min else None,
        frequency_mhz_max=float(freq.max) if freq and freq.max else None,
        load_percent=round(overall, 1),
        per_core_percent=[round(float(p), 1) for p in per_core],
    )


def _collect_memory() -> SystemMemoryInfo:
    vm = psutil.virtual_memory()
    sw = psutil.swap_memory()
    return SystemMemoryInfo(
        total_bytes=int(vm.total),
        available_bytes=int(vm.available),
        used_bytes=int(vm.used),
        free_bytes=int(vm.free),
        percent=round(float(vm.percent), 1),
        swap_total_bytes=int(sw.total),
        swap_used_bytes=int(sw.used),
        swap_percent=round(float(sw.percent), 1),
    )


# Mount-types that aren't real storage and would only add noise to the
# Storage card (procfs, sysfs, cgroups, devtmpfs, overlay, etc.).
_VIRTUAL_FSTYPES = {
    "autofs",
    "bdev",
    "binfmt_misc",
    "bpf",
    "cgroup",
    "cgroup2",
    "configfs",
    "debugfs",
    "devpts",
    "devtmpfs",
    "efivarfs",
    "fuse.gvfsd-fuse",
    "fuse.portal",
    "fuse.snapd",
    "fusectl",
    "hugetlbfs",
    "mqueue",
    "nsfs",
    "overlay",
    "proc",
    "pstore",
    "ramfs",
    "rpc_pipefs",
    "securityfs",
    "squashfs",
    "sysfs",
    "tmpfs",
    "tracefs",
}


def _read_host_mounts(host_root: str) -> list[tuple[str, str, str]]:
    """Parse the container's /proc/mounts to find host disks.

    Bind-mounting host ``/`` as ``/host`` makes every host filesystem
    visible inside the container under a ``/host``-prefixed path. The
    container's own /proc/mounts therefore lists those host disks as
    e.g. ``/dev/sda /host/mnt/data ext4 …``.

    Returns a list of ``(host_mountpoint, container_path, fstype)``:
      - host_mountpoint: the mountpoint as it appears on the HOST
                         (``/host`` stripped, "/" preserved)
      - container_path:  the path to use with psutil.disk_usage()
                         (always inside ``/host`` so statvfs works)
      - fstype:          filesystem type
    """
    out: list[tuple[str, str, str]] = []
    seen_host_mountpoints: set[str] = set()
    try:
        with open("/proc/mounts", "r", encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        return []
    for line in lines:
        parts = line.split()
        if len(parts) < 3:
            continue
        device, mountpoint, fstype = parts[0], parts[1], parts[2]
        if fstype in _VIRTUAL_FSTYPES:
            continue
        # Skip pseudo/loop devices that aren't real storage.
        if device.startswith("/dev/loop"):
            continue
        # Only consider entries inside the host bind.
        if mountpoint != host_root and not mountpoint.startswith(host_root + "/"):
            continue
        # Translate the container path back to the host's path.
        if mountpoint == host_root:
            host_mountpoint = "/"
        else:
            host_mountpoint = mountpoint[len(host_root):]
        if host_mountpoint in seen_host_mountpoints:
            continue
        seen_host_mountpoints.add(host_mountpoint)
        out.append((host_mountpoint, mountpoint, fstype))
    return out


def _collect_disks() -> list[SystemDiskPartition]:
    """Enumerate real storage partitions.

    Two modes:

    * **Host-aware** (preferred, used inside Docker): when ``HOST_ROOT``
      is set and points at a bind-mount of the host root (e.g. ``/host``
      via ``- /:/host:ro,rslave`` in compose), parse host
      ``/proc/mounts`` and call ``psutil.disk_usage`` against the bind-
      mount path so we see every host disk while reporting the original
      host mountpoint.
    * **Direct** (bare-metal / dev): fall back to ``psutil.disk_partitions``
      against the api process's own view.
    """
    import os

    out: list[SystemDiskPartition] = []
    host_root = os.environ.get("HOST_ROOT", "").rstrip("/")

    if host_root and os.path.isdir(host_root):
        for host_mountpoint, container_path, fstype in _read_host_mounts(host_root):
            try:
                usage = psutil.disk_usage(container_path)
            except (PermissionError, OSError):
                continue
            out.append(
                SystemDiskPartition(
                    mountpoint=host_mountpoint,
                    fstype=fstype,
                    total_bytes=int(usage.total),
                    used_bytes=int(usage.used),
                    free_bytes=int(usage.free),
                    percent=round(float(usage.percent), 1),
                )
            )
    else:
        try:
            partitions = psutil.disk_partitions(all=False)
        except Exception:  # noqa: BLE001
            partitions = []
        seen_mountpoints: set[str] = set()
        for p in partitions:
            if p.mountpoint in seen_mountpoints:
                continue
            if p.fstype in _VIRTUAL_FSTYPES:
                continue
            try:
                usage = psutil.disk_usage(p.mountpoint)
            except (PermissionError, OSError):
                continue
            seen_mountpoints.add(p.mountpoint)
            out.append(
                SystemDiskPartition(
                    mountpoint=p.mountpoint,
                    fstype=p.fstype or "",
                    total_bytes=int(usage.total),
                    used_bytes=int(usage.used),
                    free_bytes=int(usage.free),
                    percent=round(float(usage.percent), 1),
                )
            )

    # Dedupe by (mountpoint, total_bytes) — bind mounts of the same
    # underlying device can appear under multiple paths.
    deduped: dict[tuple[str, int], SystemDiskPartition] = {}
    for d in out:
        key = (d.mountpoint, d.total_bytes)
        if key not in deduped:
            deduped[key] = d
    out = list(deduped.values())
    out.sort(key=lambda d: d.total_bytes, reverse=True)
    return out


def _parse_smi_field(raw: str) -> str | None:
    value = raw.strip()
    if not value or value.lower() in {"n/a", "not supported", "[n/a]"}:
        return None
    return value


def _safe_float(raw: str) -> float | None:
    parsed = _parse_smi_field(raw)
    if parsed is None:
        return None
    try:
        return float(parsed)
    except ValueError:
        return None


def _safe_int(raw: str) -> int | None:
    val = _safe_float(raw)
    if val is None:
        return None
    return int(val)


def _collect_gpus_via_nvidia_smi() -> list[SystemGPUInfo]:
    """Try `nvidia-smi`. Returns [] when unavailable or on any error."""
    query = (
        "index,name,driver_version,memory.total,memory.used,memory.free,"
        "utilization.gpu,temperature.gpu"
    )
    try:
        proc = subprocess.run(  # noqa: S603 — fixed argv, no shell
            [
                "nvidia-smi",
                f"--query-gpu={query}",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=NVIDIA_SMI_TIMEOUT_SECONDS,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return []
    if proc.returncode != 0:
        return []
    gpus: list[SystemGPUInfo] = []
    for raw_line in proc.stdout.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 8:
            continue
        idx = _safe_int(parts[0]) or 0
        name = _parse_smi_field(parts[1]) or "GPU"
        driver = _parse_smi_field(parts[2])
        mem_total = _safe_int(parts[3]) or 0
        mem_used = _safe_int(parts[4]) or 0
        mem_free = _safe_int(parts[5]) or max(mem_total - mem_used, 0)
        util = _safe_float(parts[6])
        temp = _safe_float(parts[7])
        percent = (mem_used / mem_total * 100.0) if mem_total > 0 else 0.0
        gpus.append(
            SystemGPUInfo(
                index=idx,
                name=name,
                driver_version=driver,
                memory_total_mb=mem_total,
                memory_used_mb=mem_used,
                memory_free_mb=mem_free,
                memory_percent=round(percent, 1),
                utilization_percent=util,
                temperature_c=temp,
            )
        )
    return gpus


def _collect_gpus_via_pynvml() -> list[SystemGPUInfo]:
    """Optional fallback when pynvml is installed in the env."""
    try:
        import pynvml  # type: ignore[import-not-found]
    except ImportError:
        return []
    try:
        pynvml.nvmlInit()
    except Exception:  # noqa: BLE001
        return []
    gpus: list[SystemGPUInfo] = []
    try:
        try:
            driver_raw = pynvml.nvmlSystemGetDriverVersion()
            driver = (
                driver_raw.decode("utf-8")
                if isinstance(driver_raw, bytes)
                else str(driver_raw)
            )
        except Exception:  # noqa: BLE001
            driver = None
        count = pynvml.nvmlDeviceGetCount()
        for i in range(count):
            handle = pynvml.nvmlDeviceGetHandleByIndex(i)
            try:
                name_raw = pynvml.nvmlDeviceGetName(handle)
                name = (
                    name_raw.decode("utf-8")
                    if isinstance(name_raw, bytes)
                    else str(name_raw)
                )
            except Exception:  # noqa: BLE001
                name = "GPU"
            try:
                mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
                mem_total_mb = int(mem.total / (1024 * 1024))
                mem_used_mb = int(mem.used / (1024 * 1024))
                mem_free_mb = int(mem.free / (1024 * 1024))
            except Exception:  # noqa: BLE001
                mem_total_mb = mem_used_mb = mem_free_mb = 0
            try:
                util_obj = pynvml.nvmlDeviceGetUtilizationRates(handle)
                util: float | None = float(util_obj.gpu)
            except Exception:  # noqa: BLE001
                util = None
            try:
                temp_val = pynvml.nvmlDeviceGetTemperature(
                    handle, pynvml.NVML_TEMPERATURE_GPU
                )
                temp: float | None = float(temp_val)
            except Exception:  # noqa: BLE001
                temp = None
            percent = (mem_used_mb / mem_total_mb * 100.0) if mem_total_mb > 0 else 0.0
            gpus.append(
                SystemGPUInfo(
                    index=i,
                    name=name,
                    driver_version=driver,
                    memory_total_mb=mem_total_mb,
                    memory_used_mb=mem_used_mb,
                    memory_free_mb=mem_free_mb,
                    memory_percent=round(percent, 1),
                    utilization_percent=util,
                    temperature_c=temp,
                )
            )
    finally:
        try:
            pynvml.nvmlShutdown()
        except Exception:  # noqa: BLE001
            pass
    return gpus


def _collect_gpus_via_model_service() -> list[SystemGPUInfo]:
    """Fetch GPU stats from the model service.

    The api container has no GPU access — only the model container does
    (it has nvidia-smi + the NVIDIA Container Toolkit reservation). The
    model service exposes /gpus with the exact SystemGPUInfo shape, so
    we just relay it. Returns [] when the service is down, the route is
    missing (older model image), or any field fails to parse.
    """
    try:
        import httpx  # type: ignore[import-not-found]
    except ImportError:
        return []
    try:
        from carve_api.config import get_settings  # local import to avoid cycles
    except ImportError:
        return []
    try:
        base = get_settings().model_base_url
    except Exception:  # noqa: BLE001
        return []
    if not base:
        return []
    try:
        resp = httpx.get(f"{base.rstrip('/')}/gpus", timeout=2.0)
    except Exception:  # noqa: BLE001 — any network/socket error → fall through
        return []
    if resp.status_code != 200:
        return []
    try:
        payload = resp.json()
    except ValueError:
        return []
    if not isinstance(payload, list):
        return []
    gpus: list[SystemGPUInfo] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        try:
            gpus.append(SystemGPUInfo(**item))
        except Exception:  # noqa: BLE001 — skip malformed entries individually
            continue
    return gpus


def _collect_gpus_via_host_proc() -> list[SystemGPUInfo]:
    """Read GPU identity from the host's /proc/driver/nvidia tree.

    Used as a last-resort fallback when the model service is not running
    (it's behind ``--profile inference``). Gives us the GPU model name
    and driver version but no live VRAM / utilization numbers — those
    require nvidia-smi or NVML, neither of which the api container has.
    """
    import os

    host_root = os.environ.get("HOST_ROOT", "").rstrip("/")
    if not host_root:
        return []
    nvidia_dir = f"{host_root}/proc/driver/nvidia"
    gpus_dir = f"{nvidia_dir}/gpus"
    if not os.path.isdir(gpus_dir):
        return []
    # Driver version (single text line).
    driver: str | None = None
    try:
        with open(f"{nvidia_dir}/version", "r", encoding="utf-8") as fh:
            for line in fh:
                # Format: "NVRM version: NVIDIA UNIX x86_64 Kernel Module  565.57.01  …"
                if "Kernel Module" in line:
                    parts = line.split()
                    for token in parts:
                        if token.replace(".", "").isdigit() and "." in token:
                            driver = token
                            break
                    if driver:
                        break
    except OSError:
        driver = None
    out: list[SystemGPUInfo] = []
    try:
        entries = sorted(os.listdir(gpus_dir))
    except OSError:
        return []
    for idx, pci_id in enumerate(entries):
        info_path = f"{gpus_dir}/{pci_id}/information"
        name = "NVIDIA GPU"
        try:
            with open(info_path, "r", encoding="utf-8") as fh:
                for line in fh:
                    if line.lower().startswith("model:"):
                        name = line.split(":", 1)[1].strip()
                        break
        except OSError:
            pass
        out.append(
            SystemGPUInfo(
                index=idx,
                name=name,
                driver_version=driver,
                memory_total_mb=0,
                memory_used_mb=0,
                memory_free_mb=0,
                memory_percent=0.0,
                utilization_percent=None,
                temperature_c=None,
            )
        )
    return out


def _collect_gpus() -> list[SystemGPUInfo]:
    """Enumerate every GPU on the host, overlaying live stats where we can.

    The api container has no GPU access of its own, so live stats (VRAM,
    util, temp) come from the model service's ``/gpus`` endpoint. But
    the model container is pinned to a single device via
    ``device_ids: ["${SAM_GPU_ID:-1}"]`` (see docker-compose.yml — SAM
    3.1 multiplex breaks with two visible CUDA devices), so trusting its
    list as the canonical GPU inventory under-reports multi-GPU hosts.

    The fix: enumerate the host's GPU list from ``/host/proc/driver/nvidia``
    first — that surface lists every physical GPU regardless of which
    one the model container was assigned — then overlay live stats from
    the model service onto the matching host index (via ``SAM_GPU_ID``).
    """
    import os

    host_list = _collect_gpus_via_host_proc()
    model_list = _collect_gpus_via_model_service()

    # No host-proc enumeration (bare-metal dev box without the /host
    # bind). Fall back to the legacy chain so those environments still
    # see something useful.
    if not host_list:
        if model_list:
            return model_list
        gpus = _collect_gpus_via_nvidia_smi()
        if gpus:
            return gpus
        gpus = _collect_gpus_via_pynvml()
        if gpus:
            return gpus
        return []

    # When the model service sees every host GPU (NVIDIA_VISIBLE_DEVICES=all
    # and no device_ids restriction), its indices line up with the host's
    # so just return its richer payload verbatim.
    if len(model_list) >= len(host_list):
        return model_list

    if not model_list:
        return host_list

    # Model service sees a strict subset (typical: pinned to one GPU).
    # Use SAM_GPU_ID to know which host index that subset corresponds
    # to and overlay live stats there; the other GPUs keep identity-only.
    try:
        sam_gpu_id = int(os.environ.get("SAM_GPU_ID", "1"))
    except ValueError:
        sam_gpu_id = 1

    overlaid: list[SystemGPUInfo] = []
    overlay_used = False
    for host_gpu in host_list:
        if not overlay_used and host_gpu.index == sam_gpu_id:
            # Take the live stats but pin the index to the host's view
            # so UI labels stay consistent across reloads.
            overlaid.append(
                model_list[0].model_copy(update={"index": host_gpu.index})
            )
            overlay_used = True
        else:
            overlaid.append(host_gpu)
    # If SAM_GPU_ID didn't match any host index (misconfigured env),
    # attach live stats to the first host GPU so they're at least visible.
    if not overlay_used and overlaid:
        overlaid[0] = model_list[0].model_copy(
            update={"index": overlaid[0].index}
        )
    return overlaid


# --------------------------------------------------------------------------
# Cache
# --------------------------------------------------------------------------

_CACHE: dict[str, tuple[float, SystemInfo]] = {}
_CACHE_LOCK = Lock()


def _build_system_info() -> SystemInfo:
    return SystemInfo(
        os=_collect_os(),
        cpu=_collect_cpu(),
        memory=_collect_memory(),
        disks=_collect_disks(),
        gpus=_collect_gpus(),
        collected_at=datetime.now(timezone.utc).isoformat(),
    )


def _get_cached_system_info() -> SystemInfo:
    now = time.monotonic()
    with _CACHE_LOCK:
        entry = _CACHE.get("info")
        if entry is not None and (now - entry[0]) < CACHE_TTL_SECONDS:
            return entry[1]
    info = _build_system_info()
    with _CACHE_LOCK:
        _CACHE["info"] = (time.monotonic(), info)
    return info


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------

@router.get("/info", response_model=SystemInfo)
def get_system_info(
    _user: User = Depends(get_current_user),  # noqa: ARG001 — auth gate only
) -> SystemInfo:
    return _get_cached_system_info()


# --------------------------------------------------------------------------
# v3.22 — manual GPU unload from the System page.
# Admin-only. Frees SAM (image + tracker sessions) and the FO1 sidecar.
# --------------------------------------------------------------------------


class UnloadModelsResponse(BaseModel):
    sam_evicted: list[str]
    sam_sessions_released: int
    fo1_evicted: bool
    # v3.22 — measured GPU MB freed (delta of memory_reserved before/after).
    # ``None`` when CUDA isn't available on that side. Lets the System
    # page show a true number even when in-memory bookkeeping thinks
    # nothing was loaded but the GPU still held cached closure-private
    # model weights.
    sam_freed_mb: int | None = None
    fo1_freed_mb: int | None = None


@router.post("/unload-models", response_model=UnloadModelsResponse)
def unload_models_endpoint(
    _user: User = Depends(get_current_admin_user),  # noqa: ARG001 — admin gate
) -> UnloadModelsResponse:
    """Force-free every model on the GPU. Idempotent.

    Calls the model service's ``/sam/unload?which=all`` (drops the
    image predictor + text + box predictor factories + sam3.1 native
    singleton + tracker sessions) and ``/sam/vlm-fo1/unload`` (drops
    the FO1 sidecar's Qwen2.5-VL-3B weights). Both calls are
    best-effort; the response reflects what each side reported as
    actually evicted plus a measured ``*_freed_mb`` from the GPU
    allocator.
    """
    from carve_api.inference.model_client import (
        sam_unload,
        sam_vlm_fo1_unload_detailed,
    )

    sam_result = sam_unload(which="all")
    fo1_result = sam_vlm_fo1_unload_detailed()
    return UnloadModelsResponse(
        sam_evicted=list(sam_result.get("evicted", [])),
        sam_sessions_released=int(sam_result.get("sessions_released", 0)),
        fo1_evicted=bool(fo1_result.get("evicted")),
        sam_freed_mb=sam_result.get("gpu_freed_mb"),
        fo1_freed_mb=fo1_result.get("gpu_freed_mb"),
    )
