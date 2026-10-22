from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

from .common import ROOT, digest, fingerprint_model, load, now, save, open_url as urlopen
from .hardware import select_platform
from .processes import identity

# A finite campaign worker may pass its lease through an actual build command.
# A killed controller cannot release ownership while that command is still alive.
EXECUTION_LEASE_FD = None


def checked_strategy(path):
    s = load(path)
    if s.get("schema") != "embedding-strategy/1" or not s.get("approval_reference"):
        raise ValueError("Not an approved strategy receipt.")
    if fingerprint_model(s["model_path"]) != s["model_fingerprint"]:
        raise ValueError("Model files changed since HITL; inspect and reconfirm before serving.")
    manifest = load(s["manifest_path"])
    if digest(manifest) != s["manifest_digest"]:
        raise ValueError("Manifest changed since strategy approval; observe differences and reconfirm affected choices.")
    return s, manifest


def event(attempt, kind, **data):
    with (Path(attempt) / "events.jsonl").open("a") as f:
        f.write(json.dumps({"at": now(), "event": kind, **data}, ensure_ascii=False) + "\n")
        f.flush()
        os.fsync(f.fileno())


def invalidate_validation(path, reason):
    path = Path(path)
    if (path / "result.json").exists():
        previous = load(path / "result.json")
        event(path, "validation_invalidated", reason=reason, previous=previous)
        save(path / "result.json", {"verdict": "UNVERIFIED", "reason": reason,
                                    "previous_evidence": previous.get("routine"), "invalidated_at": now()})


def execute(attempt, label, argv, timeout=1800):
    """No shell interpolation. Persist intent before expensive work; retain partial logs."""
    attempt = Path(attempt)
    event(attempt, "command_started", phase=label, argv=argv, timeout_seconds=timeout)
    path = attempt / (label + ".log")
    try:
        with path.open("a") as log:
            log.write(f"\n{now()} {shlex.join(argv)}\n")
            log.flush()
            p = subprocess.Popen(argv, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                                 pass_fds=() if EXECUTION_LEASE_FD is None else (EXECUTION_LEASE_FD,))
            save(attempt / "active.json", {"phase": label, "pid": p.pid, "process": identity(p.pid), "started_at": now(), "argv": argv})
            try:
                code = p.wait(timeout=timeout)
            except (subprocess.TimeoutExpired, KeyboardInterrupt):
                import signal
                os.killpg(p.pid, signal.SIGTERM)
                try:
                    p.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    os.killpg(p.pid, signal.SIGKILL)
                    p.wait()
                raise
    except (OSError, subprocess.TimeoutExpired, KeyboardInterrupt) as exc:
        event(attempt, "command_interrupted", phase=label, error=str(exc), log=str(path))
        raise
    event(attempt, "command_finished", phase=label, returncode=code, log=str(path))
    save(attempt / "active.json", {"phase": label, "finished_at": now(), "returncode": code})
    if code:
        raise RuntimeError(f"{label} failed ({code}); inspect {path}; diagnose/adjust or preserve follow-up.")


def inspect_image(image):
    return json.loads(subprocess.check_output(["docker", "image", "inspect", image], text=True))[0]


def choose_dtype(strategy, engine):
    if strategy["device"] == "cpu":
        return "float32"
    if engine == "tei" and strategy["profile"].get("model_type") == "gemma3_text":
        # TEI 1.9 Candle Gemma3 rejects F16 on CUDA as well as CPU. Observed in
        # NAS E2E and confirmed in upstream backends/candle/src/lib.rs.
        return "float32"
    if strategy["profile"].get("checkpoint_dtype") == "bfloat16":
        return "bfloat16" if engine == "sentence-transformers" else "float32"
    return "float16"


def container_budget(manifest):
    """Leave host headroom during full-context inference, using observed values."""
    host = manifest.get("host", {})
    memory = host.get("memory", {}).get("value", {})
    total, available = memory.get("MemTotal"), memory.get("MemAvailable")
    args, evidence = [], {"source": "manifest host memory and CPU observations"}
    if isinstance(total, int) and isinstance(available, int) and min(total, available) > 0:
        limit = int(min(total * .60, available * .75))
        args += ["--memory", str(limit), "--memory-swap", str(limit)]
        evidence.update(memory_bytes=limit, swap_disabled=True,
                        rationale="At most 60% of total RAM and 75% of observed available RAM; preserve host headroom.")
    cores = host.get("cpu", {}).get("value", {}).get("logical_cores")
    if isinstance(cores, int) and cores > 0:
        cpus = max(1, cores * .75)
        args += ["--cpus", str(cpus)]
        evidence["cpus"] = cpus
    return args, evidence


def compatibility(s, manifest, adapter, versions, engine, dtype, runtime_root=None, recipes=None, model_overrides=None):
    profile = {k: v for k, v in s["profile"].items() if k != "inspected_at"}
    data = {"model": s["model_fingerprint"], "device": s["device"], "context": s["context_window"], "dimensions": s["dimensions"],
                   "profile": profile, "engine": engine, "dtype": dtype, "architecture": manifest["host"]["architecture"],
                   "os": manifest["host"]["os"], "accelerator": adapter.get("accelerator"),
                   "adapter": adapter, "versions": versions,
                   "runtime_source": {p.name: digest(p.read_text()) for p in sorted((runtime_root or ROOT / "runtime").glob("*.py"))},
                   "recipes": recipes}
    if model_overrides:
        data["model_config_overrides"] = model_overrides
    return digest(data)


def refresh_compatibility(path, cfg):
    path = Path(path)
    cfg["compatibility_key"] = compatibility(load(path / "strategy.yaml"), load(path / "manifest.yaml"),
        cfg["platform"], cfg["versions"], cfg["engine"], cfg["dtype"], path / "runtime",
        {p.name: p.read_text() for p in sorted(path.glob("Dockerfile*"))}, cfg.get("model_config_overrides"))
    cfg["previous_compatible_pass"] = find_compatible_pass(path.parents[2], cfg["compatibility_key"])
    save(path / "settings.yaml", cfg)


def find_compatible_pass(output, key):
    candidates = []
    for p in Path(output).glob("*/attempts/*/result.json"):
        try:
            result = load(p)
            if result.get("verdict") == "PASS" and result.get("compatibility_key") == key:
                candidates.append((p.stat().st_mtime_ns, str(p.parent.resolve())))
        except (ValueError, OSError):
            continue
    return max(candidates)[1] if candidates else None


def render(strategy_path, output, engine=None, reason=None):
    s, manifest = checked_strategy(strategy_path)
    profile = s["profile"]
    if profile.get("requires_model_adapter") and not profile.get("modules") and profile.get("model_type") not in {"qwen3_vl", "kanana2vec"}:
        raise ValueError(profile["requires_model_adapter"])
    adapter = select_platform(manifest, s["device"], load(ROOT / "config/platforms.yaml")["profiles"])
    if adapter.get("status") == "adapter_required":
        raise ValueError(adapter["reason"])
    chosen = engine or ("tei" if adapter.get("tei_image") else "sentence-transformers")
    if chosen == "tei" and not adapter.get("tei_image"):
        raise ValueError("No sourced TEI recipe for this manifest; adapt platform or use ST on same device.")
    if engine == "sentence-transformers" and adapter.get("tei_image") and not reason:
        raise ValueError("Record TEI incompatibility/failure evidence with --reason before ST fallback.")
    tei_modules = {"sentence_transformers.models." + name for name in ("Transformer", "Pooling", "Dense", "Normalize")}
    unsupported = [m.get("type") for m in profile.get("modules", []) if m.get("type") not in tei_modules]
    if chosen == "tei" and unsupported:
        issue = "TEI cannot preserve declared custom ST modules: " + ", ".join(map(str, unsupported))
        if engine == "tei":
            raise ValueError(issue + "; use same-device ST with recorded incompatibility evidence.")
        chosen, reason = "sentence-transformers", issue + "; select same-device ST instead of silently omitting model processing."
    budget_args, budget = container_budget(manifest)
    adapter = {**adapter, "docker_args": [*adapter.get("docker_args", []), *budget_args]}
    versions = load(ROOT / "config/versions.yaml")
    dtype = choose_dtype(s, chosen)
    key = compatibility(s, manifest, adapter, versions, chosen, dtype)
    previous = find_compatible_pass(output, key)
    attempt_id = now().replace(":", "").replace("+", "_") + "_" + uuid.uuid4().hex[:6]
    path = Path(output).resolve() / s["model"] / "attempts" / attempt_id
    path.mkdir(parents=True)
    shutil.copytree(ROOT / "runtime", path / "runtime", ignore=shutil.ignore_patterns("__pycache__"))
    save(path / "strategy.yaml", s)
    save(path / "manifest.yaml", manifest)
    cfg = {"schema": "embedding-attempt/1", "id": attempt_id, "created_at": now(), "strategy_path": str(Path(strategy_path).resolve()),
           "strategy_id": s["id"], "compatibility_key": key, "previous_compatible_pass": previous,
           "engine": chosen, "engine_reason": reason or ("TEI first; load/settings/runtime verification pending" if chosen == "tei" else "No matched upstream TEI artifact; same-device ST recipe"),
           "platform": adapter, "versions": versions, "state": "prepared",
           "dtype": dtype,
           "dtype_reason": "TEI Gemma3 requires float32; CPU float32; bf16 checkpoint preserves bf16 on ST or uses TEI float32; other GPU paths start float16. Agent can adjust with runtime evidence.",
           "recovery_policy": "Agent diagnoses evidence, adjusts recipe/patch, records changes; no repeated identical retry or phase HITL.",
           "limits": {"build_timeout_seconds": 1800,
                      "startup_timeout_seconds": 1800 if s["context_window"] >= 16384 else 600,
                      "functional_timeout_seconds": 1800 if s["context_window"] >= 16384 else 600,
                      "container": budget,
                      "source": "Initial agent execution limits for this small recipe; revise with evidence, not serving HITL."}}
    if chosen == "tei" and s["profile"].get("model_type") == "nomic_bert":
        local_config = load(Path(s["model_path"]) / "config.json")
        positions = local_config.get("n_positions")
        if not local_config.get("max_position_embeddings") and isinstance(positions, int) and positions >= s["context_window"]:
            cfg["model_config_overrides"] = {"max_position_embeddings": positions}
            cfg["model_config_override_reason"] = "TEI router needs the standard alias for observed Nomic n_positions; preserve max_trained_positions separately and keep the same approved input limit."
    if chosen == "tei" and s["profile"].get("model_type") == "qwen3":
        capacity = load(Path(s["model_path"]) / "config.json").get("max_position_embeddings")
        if isinstance(capacity, int) and capacity > s["context_window"]:
            cfg["model_config_overrides"] = {"max_position_embeddings": s["context_window"]}
            cfg["model_config_override_reason"] = "Align TEI router capacity with the approved model-card context; preserve weights and all RoPE parameters."
    save(path / "settings.yaml", cfg)
    wheel = versions.get("torch_wheels", {}).get(
        f"{adapter['torch_device']}:{manifest['host']['architecture']['value']}:cp312", {}) if adapter.get("st_base", "").startswith("python:3.12") else {}
    torch_package = shlex.quote(wheel["url"] + "#sha256=" + wheel["sha256"]) if wheel else "torch==" + versions["torch"]
    backend_dockerfile = f"FROM {adapter['tei_image']}\n" if chosen == "tei" else (
        f"FROM {adapter['st_base']}\nWORKDIR /app\n"
        f"RUN pip install --no-cache-dir --timeout 120 --retries 5 {torch_package}" + (f" --index-url {adapter['torch_index']}" if adapter.get("torch_index") else "") + "\n"
        f"RUN pip install --no-cache-dir sentence-transformers=={versions['sentence_transformers']} transformers=={versions['transformers']}\n"
        + (f"RUN pip install --no-cache-dir pillow=={versions['pillow']}\n" if versions.get("pillow") else "") +
        (f"RUN pip install --no-cache-dir --timeout 120 torchvision=={versions['torchvision']}" +
         (f" --index-url {adapter['torch_index']}" if adapter.get("torch_index") else "") + "\n" if versions.get("torchvision") else "") +
        "COPY runtime /app/runtime\nENTRYPOINT [\"python\",\"-m\",\"runtime.server\"]\n")
    (path / "Dockerfile").write_text(backend_dockerfile)
    if chosen == "tei":
        (path / "Dockerfile.gateway").write_text(f"FROM python:3.12-slim\nWORKDIR /app\nRUN pip install --no-cache-dir tokenizers=={versions['tokenizers']}\nCOPY runtime /app/runtime\nENTRYPOINT [\"python\",\"-m\",\"runtime.server\"]\n")
    (path / "serve.env").write_text("EMB_API_BIND=127.0.0.1\nEMB_API_PORT=8080\n")
    (path / "run.sh").write_text("#!/usr/bin/env bash\nset -euo pipefail\nsource " + shlex.quote(str(path / "serve.env")) + "\nexec " + shlex.join([
        sys.executable, str(ROOT / "tools/embctl.py"), "serve", "--attempt", str(path)]) + ' --bind "$EMB_API_BIND" --port "$EMB_API_PORT" "$@"\n')
    (path / "run.sh").chmod(0o755)
    refresh_compatibility(path, cfg)
    event(path, "attempt_prepared", engine=chosen, reason=cfg["engine_reason"], previous_compatible_pass=cfg["previous_compatible_pass"])
    return path


def build(path, builder=None):
    path = Path(path)
    cfg = load(path / "settings.yaml")
    checked_strategy(cfg["strategy_path"])
    refresh_compatibility(path, cfg)
    images = {}
    cfg["state"] = "building"
    save(path / "settings.yaml", cfg)
    invalidate_validation(path, "New build must pass a fresh serving verification")
    try:
        for role, file in [("backend", "Dockerfile")] + ([("gateway", "Dockerfile.gateway")] if cfg["engine"] == "tei" else []):
            recipe = digest({"dockerfile": (path / file).read_text(), "runtime": {p.name: p.read_text() for p in (path / "runtime").glob("*.py")}})[:16]
            tag = "easy-emb-" + role + ":" + recipe
            argv = ["docker", "buildx", "build", "--load", "--progress=plain"]
            if builder:
                argv += ["--builder", builder]
            argv += ["-t", tag, "-f", str(path / file), str(path)]
            execute(path, "build-" + role, argv, cfg["limits"]["build_timeout_seconds"])
            info = inspect_image(tag)
            images[role] = {"tag": tag, "id": info["Id"], "repo_digests": info.get("RepoDigests"), "recipe": recipe}
        save(path / "images.json", images)
        cfg["state"] = "built"
    except (RuntimeError, OSError, subprocess.SubprocessError, KeyboardInterrupt) as exc:
        cfg["state"] = "interrupted" if isinstance(exc, KeyboardInterrupt) else "build_failed"
        cfg["error"] = str(exc)
        raise
    finally:
        save(path / "settings.yaml", cfg)
    return {"attempt": str(path), "state": cfg["state"], "images": images}


def resolve_attempt(strategy_path, output):
    s, _ = checked_strategy(strategy_path)
    paths = []
    for p in (Path(output) / s["model"] / "attempts").glob("*/settings.yaml"):
        cfg = load(p)
        if cfg["strategy_id"] == s["id"] and (p.parent / "images.json").exists():
            paths.append((p.stat().st_mtime_ns, p.parent))
    if not paths:
        raise ValueError("No built attempt for this strategy; run build first.")
    return max(paths)[1]


def serve(path, port=8080, bind="127.0.0.1"):
    path = Path(path).resolve()
    cfg = load(path / "settings.yaml")
    s, _ = checked_strategy(cfg["strategy_path"])
    images = load(path / "images.json")
    for image in images.values():
        if inspect_image(image["id"])["Id"] != image["id"]:
            raise ValueError("Recorded image identity is not present.")
    name = "easy-emb-" + digest(str(path))[:12]
    network = name + "-net"
    runtime = {**s, "engine": cfg["engine"], "attempt_id": cfg["id"], "torch_device": cfg["platform"]["torch_device"], "dtype": cfg["dtype"]}
    runtime["backend_timeout_seconds"] = cfg["limits"].get("functional_timeout_seconds", 600)
    save(path / "runtime.json", runtime)
    model_id = "/model"
    if cfg["engine"] == "tei" and cfg.get("model_config_overrides"):
        overlay = path / "model-overlay"
        overlay.mkdir(exist_ok=True)
        for item in Path(s["model_path"]).iterdir():
            if item.name != "config.json" and not (overlay / item.name).is_symlink():
                (overlay / item.name).symlink_to("/model/" + item.name, target_is_directory=item.is_dir())
        save(overlay / "config.json", {**load(Path(s["model_path"]) / "config.json"), **cfg["model_config_overrides"]})
        save(path / "model-config-patch.json", {"source": s["model_path"], "changes": cfg["model_config_overrides"],
                                              "reason": cfg.get("model_config_override_reason")})
        model_id = "/run/embedding/model-overlay"
    mount = ["--mount", f"type=bind,src={s['model_path']},dst=/model,readonly", "--mount", f"type=bind,src={path},dst=/run/embedding,readonly"]
    owner = ["--label", f"easy-emb.attempt={cfg['id']}", "--label", f"easy-emb.strategy={s['id']}"]
    # Reconcile actual state. Never remove somebody else's container or overwrite a name.
    existing = subprocess.run(["docker", "container", "inspect", name], capture_output=True, text=True)
    if existing.returncode == 0:
        info = json.loads(existing.stdout)[0]
        if info["Config"].get("Labels", {}).get("easy-emb.attempt") != cfg["id"]:
            raise ValueError("Container name collision; refusing to overwrite.")
        if not info["State"]["Running"]:
            raise ValueError("Owned stopped container remains; inspect logs/state, record diagnosis, then stop --attempt before retry.")
        if info["Image"] != images["gateway" if cfg["engine"] == "tei" else "backend"]["id"]:
            raise ValueError("Owned container image differs from recorded build; inspect before resume.")
        recorded = load(path / "containers.json")
        if recorded["bind"] != bind or recorded["port"] != port:
            raise ValueError("Running container has a different API binding; use its recorded binding or stop it first.")
        event(path, "running_container_reconciled", container=name, state=info["State"])
    else:
        # Preserve resource identities before the first mutation, including partial starts.
        save(path / "containers.json", {"api": name, "backend": name + "-backend" if cfg["engine"] == "tei" else None,
                                         "network": network if cfg["engine"] == "tei" else None,
                                         "base_url": f"http://127.0.0.1:{port}", "bind": bind, "port": port})
        cfg["state"] = "starting"
        save(path / "settings.yaml", cfg)
        invalidate_validation(path, "New container process requires fresh verification")
        try:
            if cfg["engine"] == "tei":
                net = subprocess.run(["docker", "network", "inspect", network], capture_output=True, text=True)
                if net.returncode:
                    execute(path, "network-create", ["docker", "network", "create", "--label", f"easy-emb.attempt={cfg['id']}", network], 30)
                elif json.loads(net.stdout)[0].get("Labels", {}).get("easy-emb.attempt") != cfg["id"]:
                    raise ValueError("Network name collision; refusing to join an unowned network.")
                backend_name = name + "-backend"
                args = ["docker", "run", "-d", "--name", backend_name, *owner, "--network", network, *mount,
                        *cfg["platform"].get("docker_args", []), images["backend"]["id"], "--model-id", model_id, "--port", "80",
                        "--dtype", cfg["dtype"], "--auto-truncate", "false",
                        "--max-batch-tokens", str(max(16384, s["context_window"])), "--json-output"]
                execute(path, "start-backend", args, 60)
                gateway_image = images["gateway"]["id"]
                api_args = ["--network", network, "-e", f"EMB_TEI_URL=http://{backend_name}:80"]
            else:
                gateway_image = images["backend"]["id"]
                api_args = cfg["platform"].get("docker_args", [])
            execute(path, "start-api", ["docker", "run", "-d", "--name", name, *owner, *api_args, *mount,
                    "-p", f"{bind}:{port}:8080", "-e", "HF_HUB_OFFLINE=1", "-e", "TRANSFORMERS_OFFLINE=1",
                    gateway_image, "--config", "/run/embedding/runtime.json"], 60)
        except (RuntimeError, OSError, subprocess.SubprocessError) as exc:
            cfg.update(state="startup_failed", error=str(exc))
            save(path / "settings.yaml", cfg)
            raise
    save(path / "containers.json", {"api": name, "backend": name + "-backend" if cfg["engine"] == "tei" else None,
                                     "network": network if cfg["engine"] == "tei" else None,
                                     "base_url": f"http://127.0.0.1:{port}", "bind": bind, "port": port})
    deadline = time.monotonic() + cfg["limits"]["startup_timeout_seconds"]
    last = None
    while time.monotonic() < deadline:
        try:
            with urlopen(f"http://127.0.0.1:{port}/health", timeout=5) as response:
                if response.status == 200:
                    cfg["state"] = "serving"
                    save(path / "settings.yaml", cfg)
                    capture(path)
                    return {"attempt": str(path), "state": "serving", "base_url": f"http://127.0.0.1:{port}"}
        except (OSError, ValueError) as exc:
            last = str(exc)
        time.sleep(2)
        stopped = False
        for role, container in (("api", name), ("backend", name + "-backend" if cfg["engine"] == "tei" else None)):
            if not container:
                continue
            observed = subprocess.run(["docker", "inspect", "--format", "{{.State.Running}}", container], capture_output=True, text=True, timeout=20)
            if observed.returncode or observed.stdout.strip() != "true":
                last = f"{role} container ended before readiness; inspect captured startup logs"
                stopped = True
                break
        if stopped:
            break
    cfg.update(state="startup_failed", error=last or "Container exited before ready")
    save(path / "settings.yaml", cfg)
    capture(path)
    raise RuntimeError(f"Startup failed; {path}/container-*.log and state preserved. Diagnose TEI then same-device ST if needed.")


def capture(path):
    path = Path(path)
    containers = load(path / "containers.json")
    for role in ("api", "backend"):
        if containers.get(role):
            for verb, suffix in [("logs", "log"), ("inspect", "json")]:
                p = subprocess.run(["docker", verb, containers[role]], capture_output=True, text=True)
                (path / f"container-{role}.{suffix}").write_text(p.stdout + (p.stderr if suffix == "log" else ""))
    collect_device_evidence(path)


def collect_device_evidence(path):
    """Freeze corroborating observations; never turn an approved device into proof."""
    import re
    path = Path(path)
    try:
        cfg, strategy = load(path / "settings.yaml"), load(path / "strategy.yaml")
        if cfg["engine"] != "tei":
            return
        info = load(path / "container-backend.json")[0]
        labels = info["Config"].get("Labels", {})
        if labels.get("easy-emb.attempt") != cfg["id"] or labels.get("easy-emb.strategy") != strategy["id"] or not info["State"]["Running"]:
            return
        if info["Image"] != load(path / "images.json")["backend"]["id"]:
            return
        logs = (path / "container-backend.log").read_text()
        selected = re.search(r"Starting \w+ model on (Cpu|Cuda)", logs)
        reason, excerpt = None, None
        if selected and (selected[1] == "Cpu") == (strategy["device"] == "cpu"):
            reason, excerpt = "Observed TEI Candle model device in current backend startup log", selected[0]
        elif strategy["device"] == "cpu" and not selected:
            # CPU images may use ORT, whose startup omits Candle's device line.
            # Require the actually built CPU artifact, owned running image, no
            # accelerator assignment, and a completed model warmup/ready log.
            build = (path / "build-backend.log").read_text()
            cpu_source = cfg["platform"].get("tei_image", "")
            ready = next((line for line in logs.splitlines() if '"message":"Ready"' in line), None)
            if ":cpu-" in cpu_source and cpu_source in build and ready and not info["HostConfig"].get("DeviceRequests") and not info["HostConfig"].get("Devices"):
                reason = "CPU execution corroborated by observed CPU artifact build, matching running image, no accelerator assignment and completed warmup; not a direct provider API probe"
                excerpt = ready
        if not reason:
            return
        token = digest({"container": info["Id"], "started": info["State"].get("StartedAt"), "logs": logs})[:20]
        observations = []
        sources = [("startup.log", logs, excerpt), ("container.json", json.dumps(info, ensure_ascii=False, indent=2), info["Image"])]
        if strategy["device"] == "cpu" and not selected:
            sources.append(("build.log", build, cpu_source))
        for name, content, quote in sources:
            target = path / "device-observations" / token / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
            observations.append({"file": str(target.relative_to(path)), "digest": digest(content), "excerpt": quote})
        save(path / "device-evidence.json", {"attempt_id": cfg["id"], "device": strategy["device"], "observed_at": now(),
            "basis": reason, "observations": observations})
    except (OSError, ValueError, KeyError, IndexError, TypeError):
        # Missing observations remain unverified; functional verification owns
        # the explicit failure, rather than manufacturing an evidence receipt.
        return


def stop(path):
    path = Path(path)
    cfg = load(path / "settings.yaml")
    containers = load(path / "containers.json")
    capture(path)
    for role in ("api", "backend"):
        name = containers.get(role)
        if not name:
            continue
        p = subprocess.run(["docker", "inspect", name], capture_output=True, text=True)
        if p.returncode:
            continue
        info = json.loads(p.stdout)[0]
        if info["Config"].get("Labels", {}).get("easy-emb.attempt") != cfg["id"]:
            raise ValueError("Refusing cleanup of unowned container.")
        execute(path, "stop-" + role, ["docker", "rm", "-f", name], 60)
    if containers.get("network"):
        net = subprocess.run(["docker", "network", "inspect", containers["network"]], capture_output=True, text=True)
        if net.returncode == 0:
            if json.loads(net.stdout)[0].get("Labels", {}).get("easy-emb.attempt") != cfg["id"]:
                raise ValueError("Refusing cleanup of an unowned network.")
            execute(path, "remove-network", ["docker", "network", "rm", containers["network"]], 30)
    cfg["state"] = "stopped"
    save(path / "settings.yaml", cfg)
    return {"attempt": str(path), "state": "stopped", "evidence": "retained"}
