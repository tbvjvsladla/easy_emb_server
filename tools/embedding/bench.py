from __future__ import annotations

import concurrent.futures
import json
import math
import platform
import statistics
import subprocess
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request

from .common import digest, load, now, save, open_url as urlopen
from .attempts import capture, event


def request(url, route, body=None, timeout=120):
    req = Request(url.rstrip("/") + route, data=None if body is None else json.dumps(body).encode(),
                  headers={"Content-Type": "application/json"})
    with urlopen(req, timeout=timeout) as response:
        return json.load(response)


def vectors(response, count, dimensions):
    data = response.get("data")
    if not isinstance(data, list) or len(data) != count:
        raise ValueError("Response vector count mismatch")
    result = []
    for i, row in enumerate(data):
        if row.get("index") != i:
            raise ValueError("Response index/order mismatch")
        v = row.get("embedding")
        if not isinstance(v, list) or len(v) != dimensions or not all(
                not isinstance(x, bool) and isinstance(x, (int, float)) and math.isfinite(x) for x in v):
            raise ValueError("Response dimension or finite value mismatch")
        result.append(v)
    return result


def validate_routine(r):
    for key in ("requests", "concurrency"):
        if not isinstance(r.get(key), int) or isinstance(r[key], bool) or r[key] < 1:
            raise ValueError(f"{key} must be a positive integer")
    if not isinstance(r.get("warmup_requests"), int) or r["warmup_requests"] < 0:
        raise ValueError("warmup_requests must be nonnegative")
    if not isinstance(r.get("timeout_seconds"), (float, int)) or not math.isfinite(r["timeout_seconds"]) or r["timeout_seconds"] <= 0:
        raise ValueError("Finite positive timeout required")
    if not isinstance(r.get("inputs"), list) or len(r["inputs"]) < 2 or not all(isinstance(t, str) and t.strip() for t in r["inputs"]):
        raise ValueError("At least two nonempty text inputs required for batch/order check")
    if len(set(r["inputs"])) != len(r["inputs"]):
        raise ValueError("Distinct inputs required for order check")


def functional(url, strategy, attempt, routine):
    cfg = load(Path(attempt) / "settings.yaml")
    timeout = max(routine["timeout_seconds"], cfg.get("limits", {}).get("functional_timeout_seconds", 0))
    info = request(url, "/info", timeout=timeout)
    for key, expected in (("strategy_id", strategy["id"]), ("attempt_id", cfg["id"]),
                          ("context_window", strategy["context_window"]), ("dimensions", strategy["dimensions"]),
                          ("input_policy", "reject_over_limit")):
        if info.get(key) != expected:
            raise ValueError(f"Runtime {key} differs from current approved attempt")
    if info["backend"]["device"] != strategy["device"]:
        raise ValueError("Actual device differs from approval")
    if info["backend"].get("engine") == "sentence-transformers" and info["backend"].get("max_seq_length") != strategy["context_window"]:
        raise ValueError("Loaded ST input limit differs from approval")
    if info["backend"].get("engine") == "tei":
        upstream_limit = info["backend"].get("upstream", {}).get("max_input_length")
        if isinstance(upstream_limit, int) and upstream_limit < strategy["context_window"]:
            raise ValueError("Underlying TEI input capacity is below approval")
    observed = info["backend"].get("device_observed", False)
    evidence_path = Path(attempt) / "device-evidence.json"
    evidence = load(evidence_path) if evidence_path.exists() else None
    if not observed:
        if not evidence or evidence.get("attempt_id") != cfg["id"] or evidence.get("device") != strategy["device"] or not evidence.get("observations"):
            raise ValueError("TEI actual device needs corroborating current-attempt runtime observations in device-evidence.json")
        for item in evidence["observations"]:
            source = Path(attempt) / item["file"]
            if not source.resolve().is_relative_to(Path(attempt).resolve()) or digest(source.read_text()) != item["digest"] or item["excerpt"] not in source.read_text():
                raise ValueError("Device evidence is stale, missing or not from this attempt")
    texts = routine["inputs"]
    payload = {"input": texts, "model": strategy["model"]}
    batch = vectors(request(url, "/v1/embeddings", payload, timeout), len(texts), strategy["dimensions"])
    singles = [vectors(request(url, "/v1/embeddings", {"input": t}, timeout), 1, strategy["dimensions"])[0] for t in texts]
    # Same runtime consistency checks ordering, not model quality or external numeric parity.
    for i, v in enumerate(batch):
        distances = [sum((x-y)**2 for x, y in zip(v, single)) for single in singles]
        if any(distances[i] >= d for j, d in enumerate(distances) if i != j):
            raise ValueError("Batch order could not be confirmed against single requests")
    contextual = bool((info["backend"].get("adapter") or {}).get("contextual"))
    contextual_limit_rejected = False
    if contextual:
        expected_indices = [(0, 0), (0, 1), (1, 0)]
        try:
            response = request(url, "/v1/contextualizedembeddings",
                               {"input": [[texts[0], texts[1]], [texts[0]]]}, timeout)
        except HTTPError as exc:
            error = exc.read().decode("utf-8", errors="replace")
            if exc.code != 400 or "Input exceeds approved context_window=" not in error:
                raise
            # Individually valid inputs may exceed the approved document budget
            # when joined. Verify that rejection, then probe separate documents.
            contextual_limit_rejected = True
            expected_indices = [(i, 0) for i in range(len(texts))]
            response = request(url, "/v1/contextualizedembeddings",
                               {"input": [[text] for text in texts]}, timeout)
        vectors(response, len(expected_indices), strategy["dimensions"])
        if [(r.get("document_index"), r.get("chunk_index")) for r in response["data"]] != expected_indices:
            raise ValueError("Contextual chunk/document mapping mismatch")
        separator = info["backend"]["adapter"].get("reserved_separator")
        if separator:
            for route, value in [("/v1/embeddings", "a" + separator + "b"),
                                 ("/v1/contextualizedembeddings", [["a" + separator + "b"]])]:
                try:
                    request(url, route, {"input": value}, timeout)
                except HTTPError as exc:
                    if exc.code != 400:
                        raise ValueError("Reserved contextual separator rejection is not a client error") from exc
                else:
                    raise ValueError("Contextual encoder accepted an ambiguous embedded chunk separator")
    invalid = ["", [], [""], [1], 123, None]
    for value in invalid:
        try:
            request(url, "/v1/embeddings", {"input": value}, timeout)
        except HTTPError as exc:
            if not 400 <= exc.code < 500:
                raise ValueError("Invalid input produced server error") from exc
        else:
            raise ValueError("Invalid input accepted")
    # Find the real tokenizer boundary with the model prompt included. No hidden truncation.
    low, high = 1, strategy["context_window"] + 1
    while low + 1 < high:
        mid = (low + high) // 2
        n = request(url, "/tokenize", {"input": "a " * mid}, timeout)["lengths"][0]
        if n <= strategy["context_window"]:
            low = mid
        else:
            high = mid
    near = request(url, "/tokenize", {"input": "a " * low}, timeout)["lengths"][0]
    over = request(url, "/tokenize", {"input": "a " * high}, timeout)["lengths"][0]
    if not near <= strategy["context_window"] < over:
        raise ValueError("Unable to construct valid tokenizer boundary")
    vectors(request(url, "/v1/embeddings", {"input": "a " * low}, timeout), 1, strategy["dimensions"])
    try:
        request(url, "/v1/embeddings", {"input": "a " * high}, timeout)
    except HTTPError as exc:
        if exc.code != 400:
            raise ValueError("Over-limit input did not follow declared reject policy") from exc
    else:
        raise ValueError("Over-limit input was silently accepted/truncated")
    return {"passed": True, "runtime": info, "device_evidence": evidence, "timeout_seconds": timeout,
            "checks": ["count", "order_vs_same_runtime_singles", "dimension", "finite", "device", "input_policy", "invalid_input"]
                      + (["contextual_document_chunk_mapping"] if contextual else [])
                      + (["contextual_document_limit_rejection"] if contextual_limit_rejected else []),
            "boundary_tokens": {"accepted": near, "rejected": over}}


def memory_sample(attempt):
    data = {"at": now()}
    containers_path = Path(attempt) / "containers.json"
    if containers_path.exists():
        c = load(containers_path)
        names = [c[k] for k in ("api", "backend") if c.get(k)]
        p = subprocess.run(["docker", "stats", "--no-stream", "--format", "{{json .}}", *names], capture_output=True, text=True, timeout=20)
        data["container_memory"] = {"status": "observed" if p.returncode == 0 else "unavailable", "raw": p.stdout, "error": p.stderr}
    else:
        data["container_memory"] = {"status": "unavailable", "reason": "no container identities"}
    strategy = load(Path(attempt) / "strategy.yaml")
    if strategy["device"] == "gpu":
        platform_cfg = load(Path(attempt) / "settings.yaml")["platform"]
        if platform_cfg.get("accelerator", {}).get("vendor") == "nvidia":
            import shutil
            import os
            exe = shutil.which("nvidia-smi", path=os.environ.get("PATH", "") + ":/usr/lib/wsl/lib")
            if exe:
                p = subprocess.run([exe, "--query-gpu=uuid,memory.used,memory.total", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=20)
                data["gpu_memory"] = {"status": "observed" if p.returncode == 0 else "unavailable", "raw": p.stdout,
                                      "scope": "whole-device sample, not per-process peak", "error": p.stderr}
            else:
                data["gpu_memory"] = {"status": "unavailable", "reason": "nvidia-smi missing"}
        else:
            data["gpu_memory"] = {"status": "unavailable", "reason": "No collector for this manifest accelerator; add sourced collector."}
    else:
        data["gpu_memory"] = {"status": "not_applicable", "reason": "CPU strategy"}
    return data


def run(attempt, url, routine_path):
    path = Path(attempt)
    strategy, cfg, routine = load(path / "strategy.yaml"), load(path / "settings.yaml"), load(routine_path)
    validate_routine(routine)
    run_id = now().replace(":", "").replace("+", "_")
    evidence = path / "bench" / run_id
    evidence.mkdir(parents=True)
    save(evidence / "routine.yaml", routine)
    result = {"schema": "embedding-e2e/1", "started_at": now(), "attempt_id": cfg["id"], "strategy_id": strategy["id"],
              "compatibility_key": cfg["compatibility_key"], "routine": str((evidence / "routine.yaml").resolve()),
              "tool": {"name": "stdlib-http", "python": platform.python_version(), "source_digest": digest(Path(__file__).read_text())},
              "verdict": "FAIL", "stage": "functional", "functional": {"passed": False}, "measurement": {"valid": False}}
    event(path, "bench_started", run_id=run_id, routine=routine, base_url=url)
    # A killed client cannot leave a previous PASS masquerading as this measurement.
    save(evidence / "result.json", result)
    save(path / "result.json", result)
    records = []
    memory = []
    try:
        result["functional"] = functional(url, strategy, path, routine)
        result["stage"] = "measurement"
        body = {"input": routine["inputs"], "model": strategy["model"]}
        for _ in range(routine["warmup_requests"]):
            vectors(request(url, "/v1/embeddings", body, routine["timeout_seconds"]), len(body["input"]), strategy["dimensions"])

        def one(index):
            start = time.perf_counter()
            try:
                response = request(url, "/v1/embeddings", body, routine["timeout_seconds"])
                vectors(response, len(body["input"]), strategy["dimensions"])
                return {"index": index, "success": True, "seconds": time.perf_counter() - start}
            except Exception as exc:
                return {"index": index, "success": False, "seconds": time.perf_counter() - start,
                        "error": str(exc), "error_type": type(exc).__name__}

        memory.append(memory_sample(path))
        start = time.perf_counter()
        with concurrent.futures.ThreadPoolExecutor(max_workers=routine["concurrency"]) as pool:
            futures = [pool.submit(one, i) for i in range(routine["requests"])]
            for future in concurrent.futures.as_completed(futures):
                records.append(future.result())
        seconds = time.perf_counter() - start
        memory.append(memory_sample(path))
        success = sum(r["success"] for r in records)
        durations = sorted(r["seconds"] for r in records if r["success"])
        valid = (len(records) == routine["requests"] == success and seconds > 0 and math.isfinite(seconds)
                 and all(math.isfinite(x) and x > 0 for x in durations))
        result["measurement"] = {"valid": valid, "issued": routine["requests"], "completed": len(records),
            "success": success, "failed": len(records) - success, "duration_seconds": seconds,
            "requests_per_second": success / seconds, "vectors_per_second": success * len(body["input"]) / seconds,
            "latency_seconds": {"mean": statistics.mean(durations), "p50": statistics.median(durations),
                                "p95": durations[math.ceil(len(durations)*.95)-1]} if durations else None,
            "memory_observations": memory, "memory_scope": "before/after samples; not a peak claim"}
        result["verdict"] = "PASS" if valid else "FAIL"
        result["stage"] = "complete" if valid else "measurement_failed"
    except Exception as exc:
        result["error"] = {"type": type(exc).__name__, "message": str(exc)}
    finally:
        result["finished_at"] = now()
        save(evidence / "requests.json", records)
        save(evidence / "result.json", result)
        save(path / "result.json", result)
        event(path, "bench_finished", verdict=result["verdict"], result=str(evidence / "result.json"))
        if (path / "containers.json").exists():
            capture(path)
    return {"attempt": str(path), "verdict": result["verdict"], "stage": result["stage"], "result": str(evidence / "result.json"), "error": result.get("error")}
