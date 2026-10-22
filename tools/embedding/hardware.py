from __future__ import annotations

import csv
import io
import os
import platform
import shutil
import subprocess
from pathlib import Path

from .common import now


def command(argv, timeout=20):
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return {"status": "ok" if p.returncode == 0 else "query_failed", "command": argv,
                "returncode": p.returncode, "stdout": p.stdout.strip(), "stderr": p.stderr.strip()[-2000:]}
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"status": "query_failed", "command": argv, "error": str(exc)}


def observe(value, source, status="observed"):
    return {"value": value, "status": status, "source": source}


def pci_devices(sysfs=Path("/sys/bus/pci/devices")):
    devices, errors = [], []
    for p in sorted(sysfs.glob("*")):
        try:
            if (p / "class").read_text().strip()[2:4] != "03":
                continue
            devices.append({"address": p.name, "vendor_id": (p / "vendor").read_text().strip(),
                            "device_id": (p / "device").read_text().strip(), "source": str(p)})
        except OSError as exc:
            errors.append(str(exc))
    return {"status": "query_failed" if errors else "observed", "devices": devices, "errors": errors,
            "source": str(sysfs)}


def nvidia_probe(executable, run=command):
    if not executable:
        return {"status": "tool_missing", "devices": [], "source": "nvidia-smi PATH + WSL path"}
    result = run([executable, "--query-gpu=index,name,uuid,compute_cap,memory.total,driver_version", "--format=csv,noheader,nounits"])
    if result["status"] != "ok":
        absent = "no devices were found" in (result.get("stdout", "") + result.get("stderr", "")).lower()
        return {**result, "status": "absent" if absent else "query_failed", "devices": []}
    devices = []
    try:
        for row in csv.reader(io.StringIO(result["stdout"])):
            index, name, uuid, cc, mem, driver = [s.strip() for s in row]
            devices.append({"index": int(index), "name": name, "uuid": uuid, "vendor": "nvidia",
                            "compute_capability": cc, "memory_total_mib": float(mem), "driver_version": driver})
    except (ValueError, TypeError) as exc:
        return {**result, "status": "query_failed", "error": str(exc), "devices": []}
    return {**result, "status": "observed" if devices else "absent", "devices": devices}


def scan():
    release = platform.release()
    memory = {}
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            k, _, v = line.partition(":")
            if k in {"MemTotal", "MemAvailable"}:
                memory[k] = int(v.split()[0]) * 1024
    except (OSError, ValueError):
        pass
    os_info = platform.freedesktop_os_release() if Path("/etc/os-release").exists() else {}
    nvidia = nvidia_probe(shutil.which("nvidia-smi", path=os.environ.get("PATH", "") + ":/usr/lib/wsl/lib"))
    pci = pci_devices()
    # Vendor-neutral inventory remains present even without a vendor utility.
    accelerators = list(nvidia["devices"])
    for d in pci["devices"]:
        if d["vendor_id"] != "0x10de" or not nvidia["devices"]:
            accelerators.append({**d, "vendor": {"0x10de": "nvidia", "0x1002": "amd", "0x8086": "intel"}.get(d["vendor_id"], d["vendor_id"]),
                                 "runtime_status": "unprobed"})
    docker = shutil.which("docker")
    runtimes = {"docker": command([docker, "info", "--format", "{{json .}}"])
                if docker else {"status": "tool_missing"}}
    usage = shutil.disk_usage("/")
    return {"schema": "embedding-manifest/1", "measured_at": now(),
            "host": {"os": observe(os_info or platform.system(), "/etc/os-release + platform"),
                     "kernel": observe(release, "platform.release"),
                     "environment": observe("wsl" if "microsoft" in release.lower() or os.environ.get("WSL_INTEROP") else "native", "kernel + WSL_INTEROP presence"),
                     "architecture": observe(platform.machine(), "platform.machine"),
                     "cpu": observe({"logical_cores": os.cpu_count(), "processor": platform.processor()}, "os.cpu_count + platform.processor"),
                     "memory": observe(memory, "/proc/meminfo", "observed" if memory else "unavailable"),
                     "disk": observe({"total_bytes": usage.total, "free_bytes": usage.free}, "shutil.disk_usage('/')")},
            "accelerators": accelerators, "probes": {"nvidia": nvidia, "pci": pci}, "runtimes": runtimes,
            "verification": {"physical_e2e": [], "note": "Inventory is not a serving PASS or a hardware scope limit."}}


def select_platform(manifest, device, profiles):
    """Adapter factory. Profiles describe implemented routes, never a HW allowlist."""
    arch = manifest["host"]["architecture"]["value"]
    candidates = manifest.get("accelerators", []) if device == "gpu" else [None]
    for profile in profiles:
        if profile["device"] != device:
            continue
        if profile.get("architectures") and arch not in profile["architectures"]:
            continue
        for accelerator in candidates:
            if profile.get("vendor") and (not accelerator or accelerator.get("vendor") != profile["vendor"]):
                continue
            if profile.get("compute_capabilities") and (not accelerator or accelerator.get("compute_capability") not in profile["compute_capabilities"]):
                continue
            selected = {**profile, "accelerator": accelerator, "architecture": arch,
                        "evidence": "manifest observations + versioned platform profile; runtime validation required"}
            if accelerator and accelerator.get("vendor") == "nvidia" and accelerator.get("uuid"):
                selected["docker_args"] = ["--gpus", "device=" + accelerator["uuid"]]
            return selected
    return {"id": "adapter-required", "device": device, "architecture": arch,
            "status": "adapter_required", "reason": "No implemented route matches observed runtime; add a sourced profile, preserve selected device."}
