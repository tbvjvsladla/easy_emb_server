"""Observed process identities: a reused PID is never an execution owner."""
from __future__ import annotations

import os
from pathlib import Path


def identity(pid=None):
    pid = os.getpid() if pid is None else int(pid)
    try:
        text = Path(f"/proc/{pid}/stat").read_text()
        fields = text[text.rfind(")") + 2:].split()
        return {"pid": pid, "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
                "start_ticks": fields[19], "state": fields[0]}
    except FileNotFoundError:
        return {"pid": pid, "state": "absent"}
    except (OSError, IndexError):
        return {"pid": pid, "state": "unknown"}


def alive(record):
    if not record or not record.get("boot_id") or not record.get("start_ticks"):
        return False
    actual = identity(record["pid"])
    return (actual.get("boot_id"), actual.get("start_ticks")) == (record["boot_id"], record["start_ticks"]) and actual["state"] not in {"Z", "X", "absent", "unknown"}
