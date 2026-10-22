#!/usr/bin/env python3
"""Initialize, inspect, build, serve and verify an approved embedding strategy."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from embedding import attempts, bench, hardware, models
from embedding.common import ROOT, load, now, save

DEFAULT_MODELS = "/mnt/llm_model/Model/Embedding_model"
DEFAULT_OUTPUT = str(ROOT / "output")


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init", help="Terraform current node into a provenance-bearing manifest")
    init.add_argument("--out", default=str(ROOT / "manifest.yaml"))
    inventory = sub.add_parser("inventory", help="Inspect local metadata; never load weights")
    inventory.add_argument("--model-root", default=DEFAULT_MODELS)
    inventory.add_argument("--out", default=str(ROOT / "output/inventory.yaml"))
    inspect = sub.add_parser("inspect")
    inspect.add_argument("--model", required=True)
    approve = sub.add_parser("approve", help="Persist choices actually approved by the user")
    approve.add_argument("--model", required=True)
    approve.add_argument("--manifest", default=str(ROOT / "manifest.yaml"))
    approve.add_argument("--device", choices=["cpu", "gpu"], required=True)
    approve.add_argument("--context-window", type=int, required=True)
    approve.add_argument("--dimensions", required=True, help="native or an explicitly supported integer")
    approve.add_argument("--approval-reference", required=True)
    approve.add_argument("--output", default=DEFAULT_OUTPUT)
    for name in ("render", "build"):
        r = sub.add_parser(name)
        r.add_argument("--strategy", required=True)
        r.add_argument("--output", default=DEFAULT_OUTPUT)
        r.add_argument("--engine", choices=["tei", "sentence-transformers"])
        r.add_argument("--reason", help="Observed TEI incompatibility/failure evidence for ST fallback")
        if name == "build":
            r.add_argument("--builder", help="Agent selects builder from current host/recovery evidence")
    serve = sub.add_parser("serve")
    group = serve.add_mutually_exclusive_group(required=True)
    group.add_argument("--attempt")
    group.add_argument("--strategy")
    serve.add_argument("--output", default=DEFAULT_OUTPUT)
    serve.add_argument("--port", type=int, default=8080)
    serve.add_argument("--bind", default="127.0.0.1")
    b = sub.add_parser("bench")
    group = b.add_mutually_exclusive_group(required=True)
    group.add_argument("--attempt")
    group.add_argument("--strategy")
    b.add_argument("--output", default=DEFAULT_OUTPUT)
    b.add_argument("--base-url")
    b.add_argument("--routine", default=str(ROOT / "config/lite.yaml"))
    for name in ("stop", "capture"):
        r = sub.add_parser(name)
        r.add_argument("--attempt", required=True)
    report = sub.add_parser("report")
    report.add_argument("--inventory", default=str(ROOT / "output/inventory.yaml"))
    report.add_argument("--output", default=DEFAULT_OUTPUT)
    report.add_argument("--out", default=str(ROOT / "output/campaign-report.json"))
    campaign = sub.add_parser("campaign", help="Durable campaign checkpoints and finite phase workers")
    actions = campaign.add_subparsers(dest="action", required=True)
    c = actions.add_parser("init")
    c.add_argument("--spec", required=True)
    c.add_argument("--output", default=DEFAULT_OUTPUT)
    for name in ("status", "step", "report", "run", "answer", "attach", "retry", "resolve", "reopen", "_work"):
        c = actions.add_parser(name)
        c.add_argument("--campaign", required=True)
        if name == "run":
            c.add_argument("--timeout", type=float, default=600)
        if name == "answer":
            c.add_argument("--answer", required=True, help="Actual human answer with matching request_id, cell_id, value and approval_reference")
        if name in {"attach", "retry", "resolve", "reopen"}:
            c.add_argument("--cell", required=True)
        if name == "reopen":
            c.add_argument("--reason", required=True)
        if name == "attach":
            c.add_argument("--strategy", required=True)
        if name == "retry":
            c.add_argument("--reason", required=True)
            c.add_argument("--hypothesis", required=True)
            c.add_argument("--change", required=True)
            c.add_argument("--engine", choices=["tei", "sentence-transformers"])
            c.add_argument("--phase", choices=["serve", "bench", "stop"])
        if name == "resolve":
            c.add_argument("--outcome", choices=["FAIL", "BLOCKED", "UNVERIFIED"], required=True)
            c.add_argument("--reason", required=True)
            c.add_argument("--evidence", required=True)
            c.add_argument("--resume-condition", required=True)
        if name == "_work":
            c.add_argument("--operation-id", required=True)
            c.add_argument("--lease-fd", type=int, required=True)
    return p


def main(argv=None):
    args = parser().parse_args(argv)
    if args.command == "campaign":
        from embedding import campaign
        if args.action == "init":
            result = campaign.initialize(args.spec, args.output)
        elif args.action == "answer":
            result = campaign.answer(args.campaign, args.answer)
        elif args.action == "attach":
            result = campaign.attach_strategy(args.campaign, args.cell, args.strategy)
        elif args.action == "retry":
            result = campaign.retry(args.campaign, args.cell, args.reason, args.hypothesis, args.change, args.engine, args.phase)
        elif args.action == "resolve":
            result = campaign.resolve(args.campaign, args.cell, args.outcome, args.reason, args.evidence, args.resume_condition)
        elif args.action == "reopen":
            result = campaign.reopen(args.campaign, args.cell, args.reason)
        elif args.action == "run":
            result = campaign.run(args.campaign, args.timeout)
        elif args.action == "_work":
            result = campaign.work(args.campaign, args.operation_id, args.lease_fd)
        else:
            result = getattr(campaign, args.action)(args.campaign)
    elif args.command == "init":
        manifest = hardware.scan()
        save(args.out, manifest)
        result = {"manifest": str(Path(args.out).resolve()), "measured_at": manifest["measured_at"],
                  "architecture": manifest["host"]["architecture"], "environment": manifest["host"]["environment"],
                  "accelerators": manifest["accelerators"],
                  "probe_status": {k: v["status"] for k, v in manifest["probes"].items()},
                  "runtime_status": {k: v["status"] for k, v in manifest["runtimes"].items()}}
    elif args.command == "inventory":
        profiles = [models.inspect_model(p) for p in sorted(Path(args.model_root).iterdir()) if p.is_dir() and (p / "config.json").exists()]
        save(args.out, {"schema": "embedding-inventory/1", "created_at": now(), "root": args.model_root, "models": profiles})
        result = {"inventory": str(Path(args.out).resolve()), "count": len(profiles), "models": [
            {k: p[k] for k in ("model", "recommended_context_window", "native_dimensions", "reduction", "requires_model_adapter")} for p in profiles]}
    elif args.command == "inspect":
        result = models.inspect_model(args.model)
    elif args.command == "approve":
        result = models.approve(args.model, args.manifest, args.device, args.context_window, args.dimensions, args.approval_reference, args.output)
    elif args.command in {"render", "build"}:
        path = attempts.render(args.strategy, args.output, args.engine, args.reason)
        result = {"attempt": str(path), "state": "prepared"}
        print(json.dumps(result, ensure_ascii=False), flush=True)
        if args.command == "build":
            result = attempts.build(path, args.builder)
    elif args.command == "serve":
        path = args.attempt or attempts.resolve_attempt(args.strategy, args.output)
        result = attempts.serve(path, args.port, args.bind)
    elif args.command == "bench":
        path = Path(args.attempt or attempts.resolve_attempt(args.strategy, args.output))
        base_url = args.base_url or load(path / "containers.json")["base_url"]
        result = bench.run(path, base_url, args.routine)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["verdict"] == "PASS" else 1
    elif args.command == "stop":
        result = attempts.stop(args.attempt)
    elif args.command == "capture":
        attempts.capture(args.attempt)
        result = {"attempt": args.attempt, "captured": True}
    elif args.command == "report":
        inventory = load(args.inventory)
        rows = []
        for profile in inventory["models"]:
            paths = sorted((Path(args.output) / profile["model"] / "attempts").glob("*/settings.yaml"))
            history = []
            for path in paths:
                cfg = load(path)
                evidence = path.parent / "result.json"
                r = load(evidence) if evidence.exists() else None
                history.append({"attempt": str(path.parent), "engine": cfg["engine"], "state": cfg["state"],
                                "verdict": r["verdict"] if r else "UNVERIFIED", "evidence": str(evidence) if r else None,
                                "error": r.get("error") if r else cfg.get("error")})
            rows.append({"model": profile["model"], "history": history,
                         "verdict": history[-1]["verdict"] if history else "NOT_ATTEMPTED",
                         "follow_up": None if history and history[-1]["verdict"] == "PASS" else "Record problem, evidence, attempts and resume condition in devlog/checklist; query through wiki next session."})
        result = {"schema": "embedding-campaign/1", "at": now(), "models": rows,
                  "pass_count": sum(r["verdict"] == "PASS" for r in rows),
                  "note": "Result aggregation alone does not complete the campaign: all targets need attempted verification and documented unresolved issues."}
        save(args.out, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, RuntimeError, OSError) as exc:
        print(json.dumps({"error": str(exc), "type": type(exc).__name__}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
