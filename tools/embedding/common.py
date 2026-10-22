from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urlsplit
import urllib.request

ROOT = Path(__file__).resolve().parents[2]


class _LoopbackNoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def open_url(url, *args, **kwargs):
    """Loopback E2E survives loss of a caller-owned HTTP proxy; remote URLs retain it."""
    address = url.full_url if isinstance(url, urllib.request.Request) else url
    if urlsplit(address).hostname in {"localhost", "127.0.0.1", "::1"}:
        return urllib.request.build_opener(urllib.request.ProxyHandler({}), _LoopbackNoRedirect()).open(url, *args, **kwargs)
    return urllib.request.urlopen(url, *args, **kwargs)


def now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def load(path):
    # JSON is a YAML 1.2 subset; writers use JSON for dependency-free host tools.
    text = Path(path).read_text()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        import yaml
        return yaml.safe_load(text)


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    with tmp.open("w") as f:
        json.dump(value, f, indent=2, ensure_ascii=False, allow_nan=False)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(path)
    if hasattr(os, "O_DIRECTORY"):
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def fingerprint_model(model):
    """Metadata contents and weight size/mtime; no multi-GB weight hashing."""
    root = Path(model)
    records = []
    for p in sorted(root.rglob("*")):
        if p.is_file() and (p.suffix == ".json" or p.suffix in {".safetensors", ".bin", ".py"}):
            st = p.stat()
            row = {"path": str(p.relative_to(root)), "size": st.st_size, "mtime_ns": st.st_mtime_ns}
            if p.suffix in {".json", ".py"}:
                row["sha256"] = hashlib.sha256(p.read_bytes()).hexdigest()
            records.append(row)
    return {"method": "metadata-sha256+weight-size-mtime", "digest": digest(records)}
