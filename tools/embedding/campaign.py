"""Disk-owned campaign checkpoints shared by interactive agents and bounded workers.

The checkpoint is the single state writer. Existing strategy/attempt/bench files
remain their respective owners' evidence, referenced rather than copied here.
"""
from __future__ import annotations

from contextlib import contextmanager
import copy
import fcntl
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

from . import attempts, bench, models
from .common import ROOT, digest, load, now, save
from .processes import alive, identity

SCHEMA = "embedding-campaign-checkpoint/1"
TERMINAL = {"PASS", "FAIL", "BLOCKED", "UNVERIFIED"}
CHOICES = ("device", "context_window", "dimensions")
PHASES = ("prepare", "build", "serve", "bench", "stop", "done")


def safe_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,119}", value) or value in {".", ".."}:
        raise ValueError("Campaign and cell IDs must be safe, nonempty path components.")
    return value


@contextmanager
def locked(base):
    base = Path(base).resolve()
    if not (base / "checkpoint.json").is_file():
        raise ValueError(f"No campaign checkpoint: {base}")
    with (base / ".state.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = load(base / "checkpoint.json")
        if state.get("schema") != SCHEMA or digest(load(base / "campaign.yaml")) != state.get("declaration_digest"):
            raise ValueError("Campaign declaration/checkpoint mismatch; preserve and investigate drift.")
        yield base, state


def commit(base, state, kind, **data):
    state["sequence"] += 1
    state["updated_at"] = now()
    state["journey"].append({"sequence": state["sequence"], "at": state["updated_at"], "event": kind, **data})
    save(base / "checkpoint.json", state)


def definition(state, cell_id):
    return next(c for c in state["declaration"]["cells"] if c["id"] == cell_id)


def cell_state(state, cell_id):
    if cell_id not in state["cells"]:
        raise ValueError(f"Cell is not declared in this campaign: {cell_id}")
    return state["cells"][cell_id]


def current(state):
    return next((key for key, c in state["cells"].items() if c["phase"] != "done"), None)


@contextmanager
def execution_slot(base):
    """An inactive snapshot alone cannot authorize a mutation of execution state."""
    with (Path(base) / ".execution.lock").open("a+") as lease:
        try:
            fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ValueError("A live worker or command still owns campaign execution.") from exc
        previous_fd = attempts.EXECUTION_LEASE_FD
        attempts.EXECUTION_LEASE_FD = lease.fileno()
        try:
            yield lease
        finally:
            attempts.EXECUTION_LEASE_FD = previous_fd


def check_strategy(spec, receipt):
    strategy, _ = attempts.checked_strategy(receipt)
    if Path(strategy["model_path"]).resolve() != Path(spec["model_path"]).resolve():
        raise ValueError("Strategy belongs to another model.")
    for key, expected in spec.get("comparison", {}).items():
        if key not in CHOICES:
            raise ValueError(f"Unsupported comparison axis {key}; add an observed adapter instead of silently ignoring it.")
        if key == "dimensions" and expected == "native":
            expected = strategy["native_dimensions"]
        if strategy[key] != expected:
            raise ValueError(f"Strategy violates declared comparison axis {key}.")
    return strategy


def initialize(spec_path, root=None):
    raw = load(spec_path)
    if raw.get("schema") != "embedding-campaign/1" or not str(raw.get("goal", "")).strip():
        raise ValueError("A campaign/1 declaration and explicit goal are required.")
    if not isinstance(raw.get("cells"), list) or not raw["cells"]:
        raise ValueError("Declare a nonempty ordered cell list.")
    spec = copy.deepcopy(raw)
    campaign_id = safe_id(spec["id"])
    output = Path(root or ROOT / "output").resolve()
    base = output / "campaigns" / campaign_id
    runtime = spec.setdefault("runtime", {})
    runtime.setdefault("bind", "127.0.0.1")
    runtime.setdefault("port", 8080)
    if not isinstance(runtime["port"], int) or isinstance(runtime["port"], bool) or not 0 < runtime["port"] < 65536:
        raise ValueError("API port must be an integer from 1 to 65535.")
    routine = load(runtime.get("routine", ROOT / "config/lite.yaml"))
    bench.validate_routine(routine)
    runtime["routine"] = routine
    cells = {}
    for cell in spec["cells"]:
        if set(cell) - {"id", "model_path", "comparison", "build", "strategy"}:
            raise ValueError("Unknown cell inputs; declare implemented comparison/build settings explicitly.")
        cid = safe_id(cell["id"])
        if cid in cells:
            raise ValueError("Duplicate cell ID.")
        cell["model_path"] = str(Path(cell["model_path"]).resolve())
        if not (Path(cell["model_path"]) / "config.json").is_file():
            raise ValueError(f"Model metadata is missing: {cell['model_path']}")
        if not isinstance(cell.get("comparison", {}), dict) or set(cell.get("comparison", {})) - set(CHOICES):
            raise ValueError("Comparison supports device/context_window/dimensions; build setup is declared under build.")
        cell.setdefault("comparison", {})
        build = cell.setdefault("build", {})
        if set(build) - {"builder", "recipes"}:
            raise ValueError("Unknown build setup; supported inputs are builder and recipes.")
        snapshots = {}
        for filename, source in build.get("recipes", {}).items():
            if filename not in {"Dockerfile", "Dockerfile.gateway"}:
                raise ValueError("Recipe overrides must name generated Dockerfiles.")
            text = Path(source).read_text()
            snapshots[filename] = {"source": str(Path(source).resolve()), "content": text, "digest": digest(text)}
        build["recipes"] = snapshots
        receipt = str(Path(cell["strategy"]).resolve()) if cell.get("strategy") else None
        if receipt:
            check_strategy(cell, receipt)
        cell["strategy"] = receipt
        cells[cid] = {"id": cid, "strategy": receipt, "selection": {}, "phase": "prepare", "outcome": "pending",
                      "attempts": [], "attempt": None, "request": None, "recovery": None,
                      "evidence": [], "unresolved": None}
    base.parent.mkdir(parents=True, exist_ok=True)
    # mkdir is exclusive: an existing campaign is resumed, never reinitialized.
    base.mkdir()
    save(base / "campaign.yaml", spec)
    save(base / "routine.yaml", routine)
    state = {"schema": SCHEMA, "id": campaign_id, "created_at": now(), "updated_at": now(), "sequence": 0,
             "declaration": spec, "declaration_digest": digest(spec), "model_output": str(output), "cells": cells,
             "active": None, "invocations": [], "requests": {}, "journey": [], "report": None}
    commit(base, state, "campaign_created", source=str(Path(spec_path).resolve()))
    return status(base)


def observed_resources(path):
    """Read actual owned resources. Never mutate or infer liveness from a PID alone."""
    path = Path(path)
    cfg = load(path / "settings.yaml")
    result = {"attempt": str(path), "settings_state": cfg["state"], "process": None, "containers": [], "images": []}
    if (path / "active.json").exists():
        command = load(path / "active.json")
        result["process"] = {**command, "alive": alive(command.get("process"))}
    def inspect(kind, name):
        try:
            p = subprocess.run(["docker", kind, "inspect", name], capture_output=True, text=True, timeout=20)
            if p.returncode:
                missing = "no such" in p.stderr.lower()
                return {"present": False if missing else None, "probe_status": "absent" if missing else "query_failed", "error": p.stderr}, None
            return {"present": True, "probe_status": "observed"}, json.loads(p.stdout)[0]
        except (OSError, subprocess.TimeoutExpired, ValueError, IndexError) as exc:
            return {"present": None, "probe_status": "query_failed", "error": str(exc)}, None
    for image in (load(path / "images.json").values() if (path / "images.json").exists() else []):
        probe, _ = inspect("image", image["id"])
        result["images"].append({"id": image["id"], **probe})
    containers = load(path / "containers.json") if (path / "containers.json").exists() else {}
    for role in ("api", "backend"):
        name = containers.get(role)
        if not name:
            continue
        probe, info = inspect("container", name)
        if not info:
            result["containers"].append({"role": role, "name": name, **probe})
            continue
        owned = info["Config"].get("Labels", {}).get("easy-emb.attempt") == cfg["id"]
        result["containers"].append({"role": role, "name": name, **probe, "owned": owned,
                                     "running": info["State"]["Running"], "image": info["Image"]})
    return result


def summary(base, state):
    cid = current(state)
    active = state.get("active")
    question = state["cells"][cid].get("request") if cid else None
    request = state["requests"].get(question) if question else None
    if request and request["state"] == "pending":
        task_state, action = "input-required", "answer"
    elif not cid:
        task_state, action = ("completed", "none") if state.get("report") else ("working", "report")
    elif state["cells"][cid].get("recovery"):
        task_state, action = "working", "diagnose-and-retry-or-resolve"
    else:
        task_state, action = "working", "observe" if active else "step"
    return {"schema": "embedding-campaign-status/1", "campaign": str(base), "campaign_id": state["id"],
            "goal": state["declaration"]["goal"], "sequence": state["sequence"], "task_state": task_state,
            "campaign_complete": bool(state.get("report")),
            "resumable": bool(cid) or any(c["unresolved"] for c in state["cells"].values()), "next_action": action,
            "current_cell": cid, "active": active, "hitl": request,
            "cells": [{k: c[k] for k in ("id", "phase", "outcome", "strategy", "attempt", "recovery", "unresolved")} for c in state["cells"].values()],
            "journey_tail": state["journey"][-4:], "report": state.get("report"),
            "resume_command": [sys.executable, str(ROOT / "tools/embctl.py"), "campaign", "step", "--campaign", str(base)]}


def status(base):
    with locked(base) as (base, state):
        out = summary(base, state)
        if out.get("active"):
            out["active"] = {**out["active"], "owner_alive": alive(out["active"].get("process"))}
        return out


def ensure_question(state, cid):
    cell = state["cells"][cid]
    if cell["request"]:
        return
    spec = definition(state, cid)
    field = next((key for key in CHOICES if key not in cell["selection"]), None)
    if field is None:
        raise ValueError("Selections have no receipt; preserve and investigate interrupted approval.")
    profile = models.inspect_model(spec["model_path"])
    scope = {"declaration": state["declaration_digest"], "cell": cid, "field": field,
             "prior": cell["selection"], "model_fingerprint": profile["fingerprint"]}
    key = cid + "-" + digest(scope)[:16]
    suggested = spec["comparison"].get(field)
    state["requests"][key] = {"id": key, "cell_id": cid, "field": field, "scope": scope, "state": "pending",
        "question": {"device": "CPU 또는 GPU를 선택하세요.", "context_window": "최대 입력 토큰을 선택하세요.",
                     "dimensions": "원래 출력 차원 또는 모델이 지원하는 축소 차원을 선택하세요."}[field],
        "supported": {"device": ["cpu", "gpu"], "context_window": profile["recommended_context_window"],
                      "dimensions": {"native": profile["native_dimensions"], "reduction": profile["reduction"]}}[field],
        "suggested": suggested, "created_at": now(), "resume_point": {"cell_id": cid, "phase": cell["phase"]}}
    cell["request"] = key


def strategy_question(state, cid, error):
    cell, spec = state["cells"][cid], definition(state, cid)
    if cell["request"]:
        return
    profile = models.inspect_model(spec["model_path"])
    scope = {"declaration": state["declaration_digest"], "cell": cid, "field": "strategy",
             "model_fingerprint": profile["fingerprint"], "previous_strategy": cell["strategy"]}
    key = cid + "-strategy-" + digest(scope)[:16]
    state["requests"][key] = {"id": key, "cell_id": cid, "field": "strategy", "scope": scope, "state": "pending",
        "question": "기존 승인 근거와 현재 모델/환경이 달라졌습니다. 실제 사용자 결정이 기록된 호환 승인 영수증 경로를 전달하세요.",
        "reason": str(error), "supported": {"context_window": profile["recommended_context_window"],
            "native_dimensions": profile["native_dimensions"], "reduction": profile["reduction"]},
        "created_at": now(), "resume_point": {"cell_id": cid, "phase": cell["phase"]}}
    cell["request"] = key


def answer(base, answer_path):
    payload = load(answer_path)
    if not isinstance(payload.get("approval_reference"), str) or not payload["approval_reference"].strip():
        raise ValueError("An actual human answer reference is required.")
    with locked(base) as (base, state):
        request = state["requests"].get(payload.get("request_id"))
        if not request or payload.get("cell_id") != request["cell_id"]:
            raise ValueError("Answer does not match the campaign question and cell.")
        if request["state"] == "answered":
            if request["answer"] == payload:
                return summary(base, state)
            raise ValueError("An answered question cannot be silently replaced.")
        cid = request["cell_id"]
        cell, spec = cell_state(state, cid), definition(state, cid)
        profile = models.inspect_model(spec["model_path"])
        if profile["fingerprint"] != request["scope"]["model_fingerprint"] or cell["request"] != request["id"]:
            raise ValueError("Approval scope changed; do not apply a stale answer.")
        key, value = request["field"], payload.get("value")
        if key == "strategy":
            if not isinstance(value, str):
                raise ValueError("A compatible genuinely approved strategy receipt path is required.")
            replacement = check_strategy(spec, value)
            if cell["attempts"] and cell["strategy"] and Path(cell["strategy"]).exists():
                old = load(cell["strategy"])
                if any(old[k] != replacement[k] for k in CHOICES):
                    raise ValueError("Changed strategy comparison values require another cell.")
            with execution_slot(base):
                if state["active"]:
                    raise ValueError("Observe active execution before replacing its approval scope.")
                cell["strategy"] = str(Path(value).resolve())
                cell["recovery"] = None
                if cell["attempt"] and (Path(cell["attempt"]) / "containers.json").exists():
                    cell.update(phase="stop", next_after_stop="prepare")
                else:
                    cell.update(phase="prepare", attempt=None)
                request.update(state="answered", answer=payload, answered_at=now())
                cell["request"] = None
                commit(base, state, "compatible_approval_reconnected", cell_id=cid, request_id=request["id"])
                return summary(base, state)
        if key == "device" and value not in {"cpu", "gpu"}:
            raise ValueError("Choose cpu or gpu.")
        if key == "context_window" and (not isinstance(value, int) or isinstance(value, bool) or value <= 0 or value > (profile["recommended_context_window"] or 0)):
            raise ValueError("Input limit lacks model support.")
        if key in spec["comparison"]:
            expected = spec["comparison"][key]
            actual = value
            if key == "dimensions":
                expected = profile["native_dimensions"] if expected == "native" else expected
                actual = profile["native_dimensions"] if actual == "native" else actual
            if actual != expected:
                raise ValueError("Answer changes a declared comparison condition; declare another cell instead.")
        cell["selection"][key] = {"value": value, "approval_reference": payload["approval_reference"]}
        if all(k in cell["selection"] for k in CHOICES):
            values = {k: cell["selection"][k]["value"] for k in CHOICES}
            receipt = models.approve(spec["model_path"], ROOT / "manifest.yaml", values["device"], values["context_window"], str(values["dimensions"]),
                                     json.dumps(cell["selection"], ensure_ascii=False), state["model_output"])
            check_strategy(spec, receipt["strategy"])
            cell["strategy"] = receipt["strategy"]
        request.update(state="answered", answer=payload, answered_at=now())
        cell["request"] = None
        commit(base, state, "human_answer_recorded", cell_id=cid, request_id=request["id"], field=key)
        return summary(base, state)


def attach_strategy(base, cid, receipt):
    with locked(base) as (base, state):
        cell = cell_state(state, cid)
        if cell["attempts"] or state["active"]:
            raise ValueError("Cannot replace a strategy after work has started.")
        check_strategy(definition(state, cid), receipt)
        cell["strategy"] = str(Path(receipt).resolve())
        if cell["request"]:
            state["requests"][cell["request"]].update(state="answered", answer={"existing_receipt": cell["strategy"]}, answered_at=now())
            cell["request"] = None
        commit(base, state, "approved_strategy_attached", cell_id=cid, strategy=cell["strategy"])
        return summary(base, state)


def prepare(base, state, cid, engine=None, reason=None):
    cell, spec = state["cells"][cid], definition(state, cid)
    check_strategy(spec, cell["strategy"])
    path = None
    try:
        path = attempts.render(cell["strategy"], state["model_output"], engine, reason)
        for filename, snapshot in spec["build"].get("recipes", {}).items():
            if filename == "Dockerfile.gateway" and load(path / "settings.yaml")["engine"] != "tei":
                raise ValueError("A gateway recipe comparison requires a TEI attempt; ST has no gateway build.")
            if digest(snapshot["content"]) != snapshot["digest"]:
                raise ValueError("Recipe snapshot was altered.")
            (path / filename).write_text(snapshot["content"])
        attempts.refresh_compatibility(path, load(path / "settings.yaml"))
    except Exception as exc:
        error = {"type": type(exc).__name__, "message": str(exc)}
        evidence = base / "workers" / ("prepare-" + uuid.uuid4().hex + ".json")
        save(evidence, {"cell_id": cid, "phase": "prepare", "at": now(), "error": error,
                        "strategy": cell["strategy"], "partial_attempt": str(path) if path else None})
        cell["evidence"].append(str(evidence))
        cell["recovery"] = {"phase": "prepare", "error": error, "evidence": str(evidence)}
        commit(base, state, "preparation_failed", cell_id=cid, error=error, evidence=str(evidence))
        return False
    cell["attempt"] = str(path)
    cell["attempts"].append({"path": str(path), "attempt_id": load(path / "settings.yaml")["id"], "created_at": now(), "reason": reason})
    cell.update(phase="build", outcome="running", recovery=None)
    commit(base, state, "attempt_prepared", cell_id=cid, attempt=str(path), reason=reason)
    return True


def step(base):
    with locked(base) as (base, state):
        lease = (base / ".execution.lock").open("a+")
        try:
            try:
                fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                out = summary(base, state)
                out.update(next_action="observe", execution_lease="held")
                return out
            # A free lease plus stale running intent is an interrupted operation,
            # never proof of completion and never permission for an identical retry.
            if state.get("active"):
                old = state["active"]
                if alive(old.get("process")):
                    out = summary(base, state)
                    out.update(next_action="observe", execution_lease="owner-alive-checkpoint-retained")
                    return out
                c = state["cells"][old["cell_id"]]
                observed = observed_resources(c["attempt"]) if c["attempt"] else None
                c["recovery"] = {"reason": "Worker ended before checkpoint completion", "operation": old,
                                   "observed": observed, "next": "Inspect evidence and retry with a hypothesis/change, or resolve with a follow-up."}
                state["active"] = None
                commit(base, state, "interrupted_worker_reconciled", cell_id=old["cell_id"], observed=observed)
            cid = current(state)
            if cid is None:
                return summary(base, state)
            cell = state["cells"][cid]
            if not cell["strategy"]:
                ensure_question(state, cid)
                # Repeated steps do not rewrite or duplicate an unanswered question.
                if not any(e.get("request_id") == cell["request"] for e in state["journey"]):
                    commit(base, state, "human_input_required", cell_id=cid, request_id=cell["request"])
                return summary(base, state)
            if cell["phase"] != "stop":
                try:
                    check_strategy(definition(state, cid), cell["strategy"])
                except (ValueError, OSError) as exc:
                    strategy_question(state, cid, exc)
                    if not any(e.get("request_id") == cell["request"] for e in state["journey"]):
                        commit(base, state, "changed_approval_scope", cell_id=cid, request_id=cell["request"])
                    return summary(base, state)
            if cell["recovery"]:
                return summary(base, state)
            if cell["phase"] == "prepare":
                if not prepare(base, state, cid):
                    return summary(base, state)
            operation_id = uuid.uuid4().hex
            invocation_id = uuid.uuid4().hex
            state["active"] = {"operation_id": operation_id, "invocation_id": invocation_id, "cell_id": cid,
                               "phase": cell["phase"], "started_at": now(), "process": None}
            argv = [sys.executable, str(ROOT / "tools/embctl.py"), "campaign", "_work", "--campaign", str(base),
                    "--operation-id", operation_id, "--lease-fd", str(lease.fileno())]
            log = base / "workers" / (operation_id + ".log")
            log.parent.mkdir(exist_ok=True)
            with log.open("w") as stream:
                worker = subprocess.Popen(argv, stdout=stream, stderr=subprocess.STDOUT, pass_fds=(lease.fileno(),), start_new_session=True)
            state["active"]["process"] = identity(worker.pid)
            state["active"]["log"] = str(log)
            state["invocations"].append({"id": invocation_id, "caller": identity(), "worker": identity(worker.pid),
                                          "codex_thread_id": os.environ.get("CODEX_THREAD_ID"),
                                          "cell_id": cid, "attempt": cell["attempt"], "phase": cell["phase"], "started_at": now()})
            commit(base, state, "phase_started", **state["active"])
            return summary(base, state)
        finally:
            # Do not LOCK_UN here: the worker inherited the same open-file lease.
            lease.close()


def valid_result(cell):
    try:
        path = Path(cell["attempt"])
        result = load(path / "result.json")
        cfg, strategy = load(path / "settings.yaml"), load(path / "strategy.yaml")
        measurement = result.get("measurement", {})
        count, duration = measurement.get("issued"), measurement.get("duration_seconds")
        routine = Path(result["routine"]).resolve()
        if not routine.is_relative_to((path / "bench").resolve()) or load(routine.parent / "result.json") != result:
            return False
        requests = load(routine.parent / "requests.json")
        actual_key = attempts.compatibility(strategy, load(path / "manifest.yaml"), cfg["platform"], cfg["versions"], cfg["engine"], cfg["dtype"],
            path / "runtime", {p.name: p.read_text() for p in sorted(path.glob("Dockerfile*"))}, cfg.get("model_config_overrides"))
        return (result.get("verdict") == "PASS" and result.get("attempt_id") == cfg["id"]
                and result.get("strategy_id") == strategy["id"] and bool(result.get("finished_at"))
                and result.get("compatibility_key") == cfg.get("compatibility_key") == actual_key
                and result.get("functional", {}).get("passed") is True and measurement.get("valid") is True
                and isinstance(count, int) and not isinstance(count, bool) and count > 0
                and isinstance(duration, (int, float)) and math.isfinite(duration) and duration > 0
                and count == measurement.get("completed") == measurement.get("success") == len(requests) and measurement.get("failed") == 0
                and {r["index"] for r in requests} == set(range(count))
                and all(r.get("success") is True and math.isfinite(r["seconds"]) and r["seconds"] > 0 for r in requests)
                and load(routine)["requests"] == count)
    except (OSError, ValueError, TypeError, KeyError):
        return False


def work(base, operation_id, lease_fd):
    """One finite phase. The inherited lease survives termination of its caller."""
    expected = Path(base).resolve() / ".execution.lock"
    observed_fd, expected_fd = os.fstat(lease_fd), expected.stat()
    if (observed_fd.st_dev, observed_fd.st_ino) != (expected_fd.st_dev, expected_fd.st_ino):
        raise ValueError("Worker must inherit the campaign execution lease.")
    fcntl.flock(lease_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    attempts.EXECUTION_LEASE_FD = lease_fd
    with locked(base) as (base, state):
        active = state["active"]
        if not active or active["operation_id"] != operation_id or not alive(active["process"]) or active["process"]["pid"] != os.getpid():
            raise ValueError("Worker does not own this campaign operation.")
        cid, phase = active["cell_id"], active["phase"]
        cell = copy.deepcopy(state["cells"][cid])
        spec, runtime = definition(state, cid), state["declaration"]["runtime"]
        path = Path(cell["attempt"])
    error, result, observed = None, None, None
    try:
        if phase != "stop":
            check_strategy(spec, cell["strategy"])
        if load(base / "routine.yaml") != runtime["routine"]:
            raise ValueError("Declared measurement routine snapshot changed.")
        observed = observed_resources(path)
        if any(r.get("probe_status") == "query_failed" for r in observed["containers"] + observed["images"]):
            raise ValueError("Resource observation failed; absence and completion are unverified.")
        if any(c.get("present") and not c.get("owned") for c in observed["containers"]):
            raise ValueError("Foreign container identity; refusing operation.")
        if phase == "build":
            result = attempts.build(path, spec["build"].get("builder"))
        elif phase == "serve":
            result = attempts.serve(path, runtime["port"], runtime["bind"])
        elif phase == "bench":
            result = bench.run(path, load(path / "containers.json")["base_url"], base / "routine.yaml")
            if not valid_result(cell):
                raise RuntimeError(f"Cell verification did not pass: {result}")
        elif phase == "stop":
            result = attempts.stop(path) if (path / "containers.json").exists() else {"stopped": True, "reason": "No containers created"}
        else:
            raise ValueError(f"Unknown finite phase: {phase}")
    except Exception as exc:
        error = {"type": type(exc).__name__, "message": str(exc)}
    with locked(base) as (base, state):
        if not state["active"] or state["active"]["operation_id"] != operation_id:
            raise ValueError("Operation ownership changed; do not overwrite checkpoint.")
        cell = state["cells"][cid]
        save(base / "workers" / (operation_id + ".json"), {"operation": active, "finished_at": now(), "observed": observed, "result": result, "error": error})
        cell["evidence"].append(str(base / "workers" / (operation_id + ".json")))
        if error:
            cell["recovery"] = {"phase": phase, "error": error, "evidence": cell["evidence"][-1]}
        else:
            if phase == "bench":
                cell["outcome"] = "PASS"
                cell["evidence"].append(str(path / "result.json"))
            if phase == "stop" and cell.get("next_after_stop"):
                cell["phase"] = cell.pop("next_after_stop")
                cell["attempt"] = None
            else:
                cell["phase"] = PHASES[PHASES.index(phase) + 1]
        state["active"] = None
        state["invocations"][-1].update(finished_at=now(), phase_result="failed" if error else "done")
        commit(base, state, "phase_finished", cell_id=cid, phase=phase, error=error, result=result)
        return summary(base, state)


def retry(base, cid, reason, hypothesis, change, engine=None, phase=None):
    if not all(isinstance(x, str) and x.strip() for x in (reason, hypothesis, change)):
        raise ValueError("Recovery needs previous failure, hypothesis and changed condition.")
    with locked(base) as (base, state):
        cell = cell_state(state, cid)
        if cid != current(state) or not cell["recovery"] or state["active"]:
            raise ValueError("Only the current interrupted/failed operation can be retried.")
        with execution_slot(base):
            observed = observed_resources(cell["attempt"]) if cell["attempt"] else {"process": None, "containers": [], "images": []}
            if any(r.get("probe_status") == "query_failed" for r in observed["containers"] + observed["images"]):
                raise ValueError("Inspect resource probe failures before recovery; no duplicate operation authorized.")
            if observed["process"] and observed["process"]["alive"]:
                raise ValueError("Recorded command is alive; no duplicate recovery.")
            old = copy.deepcopy(cell["recovery"])
            commit(base, state, "recovery_decided", cell_id=cid, previous=old, reason=reason, hypothesis=hypothesis, change=change, observed=observed)
            if phase:
                if not cell["attempt"]:
                    raise ValueError("A preparation failure needs a new attempt before retrying a runtime phase.")
                if phase not in {"serve", "bench", "stop"}:
                    raise ValueError("Retry phase must be serve, bench or stop; new builds use a new attempt.")
                cell.update(phase=phase, recovery=None)
                if phase != "stop":
                    cell["outcome"] = "running"
            else:
                if cell["attempt"] and (Path(cell["attempt"]) / "containers.json").exists():
                    attempts.stop(cell["attempt"])
                previous = cell["attempt"]
                selected = engine or (load(Path(previous) / "settings.yaml")["engine"] if previous else None)
                if not prepare(base, state, cid, engine=selected, reason=reason):
                    return summary(base, state)
                cell["attempts"][-1].update(previous_attempt=previous, hypothesis=hypothesis, change=change)
            commit(base, state, "recovery_prepared", cell_id=cid, phase=cell["phase"])
            return summary(base, state)


def resolve(base, cid, outcome, reason, evidence, resume_condition):
    if outcome not in TERMINAL - {"PASS"} or not all((reason, evidence, resume_condition)):
        raise ValueError("Unresolved outcomes require reason, evidence and a resume condition; PASS is measured only.")
    with locked(base) as (base, state), execution_slot(base):
        cell = cell_state(state, cid)
        if cid != current(state) or state["active"]:
            raise ValueError("Resolve only the inactive current cell.")
        if not Path(evidence).exists():
            raise ValueError("Follow-up evidence must exist.")
        cell.update(outcome=outcome, recovery=None,
                    unresolved={"reason": reason, "evidence": str(Path(evidence).resolve()), "resume_condition": resume_condition})
        cell["phase"] = "stop" if cell["attempt"] and (Path(cell["attempt"]) / "containers.json").exists() else "done"
        commit(base, state, "cell_unresolved", cell_id=cid, outcome=outcome, follow_up=cell["unresolved"])
        return summary(base, state)


def report(base):
    with locked(base) as (base, state), execution_slot(base):
        if current(state) or state["active"]:
            raise ValueError("Campaign work remains; partial progress is not a completion report.")
        for cell in state["cells"].values():
            if cell["outcome"] not in TERMINAL or (cell["outcome"] == "PASS" and not valid_result(cell)):
                raise ValueError("Cell outcome lacks current measured evidence.")
            if cell["outcome"] != "PASS" and not cell["unresolved"]:
                raise ValueError("Non-PASS cell needs an unresolved handoff.")
        if state.get("report"):
            return summary(base, state)
        doc = {"schema": "embedding-campaign-report/1", "campaign_id": state["id"], "generated_at": now(),
               "validation_and_report_complete": True, "all_cells_passed": all(c["outcome"] == "PASS" for c in state["cells"].values()),
               "cells": state["cells"], "invocations": state["invocations"], "declaration": str(base / "campaign.yaml")}
        target = base / "reports" / (str(state["sequence"] + 1) + ".json")
        save(target, doc)
        state["report"] = str(target)
        commit(base, state, "campaign_reported", report=state["report"])
        return summary(base, state)


def reopen(base, cid, reason):
    if not isinstance(reason, str) or not reason.strip():
        raise ValueError("Reopening an unresolved cell needs a new reason or changed condition.")
    with locked(base) as (base, state), execution_slot(base):
        cell = cell_state(state, cid)
        if state["active"] or cell["phase"] != "done" or not cell["unresolved"] or cell["outcome"] == "PASS":
            raise ValueError("Reopen only a terminal unresolved cell with no active worker.")
        if state.get("report"):
            state.setdefault("report_history", []).append(state["report"])
            state["report"] = None
        cell.setdefault("follow_up_history", []).append({"previous": cell["unresolved"], "reopened_at": now(), "reason": reason})
        cell.update(phase="prepare", outcome="pending", attempt=None, recovery=None, unresolved=None)
        commit(base, state, "unresolved_cell_reopened", cell_id=cid, reason=reason)
        return summary(base, state)


def run(base, timeout=600, poll_seconds=1):
    """Bounded invocation; a caller timeout never discards durable finite work."""
    if not 0 < timeout < float("inf") or not 0 < poll_seconds <= 30:
        raise ValueError("Finite positive invocation timeout and poll interval required.")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = step(base)
        if result["task_state"] in {"completed", "input-required"} or result["next_action"].startswith("diagnose"):
            return result
        if result["next_action"] == "report":
            return report(base)
        time.sleep(poll_seconds)
    result = status(base)
    result["yield_reason"] = "invocation_budget"
    return result
