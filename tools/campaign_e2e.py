#!/usr/bin/env python3
"""Real Codex CLI discovery and interrupted campaign continuity evidence.

This driver never substitutes a mock/Python invocation for codex exec, creates an
approval, edits a strategy, or reports a model PASS from a CLI self-report.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

from embedding import campaign
from embedding.common import ROOT, load, now, save
from embedding.processes import alive, identity


def source_snapshot():
    files = subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=ROOT).decode().split("\0")
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in files if name and (ROOT / name).is_file()}


def event_threads(path):
    ids = []
    for line in Path(path).read_text().splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue  # A killed process can leave only its final JSONL line partial.
        if item.get("type") == "thread.started" and item.get("thread_id"):
            ids.append(item["thread_id"])
    return ids


def control_errors(path):
    errors = []
    for line in Path(path).read_text().splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if item.get("type") in {"error", "turn.failed"}:
            message = item.get("message") or item.get("error", {}).get("message")
            if message and message not in errors:
                errors.append(message)
    return errors


def launch(out, label, prompt, sandbox, schema):
    if sandbox not in {"read-only", "workspace-write"}:
        raise ValueError("Discovery is read-only; continuity uses existing project permissions.")
    target = out / label
    target.mkdir()
    save(target / "response.schema.json", schema)
    # A legacy --sandbox flag overrides default_permissions and its Docker socket
    # allowlist. Continuity uses the existing trusted project profile unchanged.
    permissions = ["-s", "read-only"] if sandbox == "read-only" else []
    argv = [shutil.which("codex") or "codex", "exec", "-C", str(ROOT), *permissions, "--json", "--color", "never",
            "--output-schema", str(target / "response.schema.json"), "-o", str(target / "last.json"), "-"]
    save(target / "intent.json", {"argv": argv, "cwd": str(ROOT), "started_at": now(), "prompt": prompt,
                                   "model_selection": "Existing CLI default, no model override", "fallback_used": "none",
                                   "permissions": "explicit read-only" if permissions else "existing project default_permissions"})
    events = (target / "events.jsonl").open("w")
    errors = (target / "stderr.log").open("w")
    process = subprocess.Popen(argv, cwd=ROOT, stdin=subprocess.PIPE, stdout=events, stderr=errors, text=True, start_new_session=True)
    process.stdin.write(prompt)
    process.stdin.close()
    save(target / "process.json", identity(process.pid))
    return process, target, (events, errors)


def finish(process, target, streams, timeout):
    try:
        code = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        code = process.returncode
    finally:
        for stream in streams:
            stream.close()
    result = {"returncode": code, "thread_ids": event_threads(target / "events.jsonl"), "finished_at": now(),
              "primary_invoked": True, "fallback_used": "none", "events": str(target / "events.jsonl")}
    result["errors"] = control_errors(target / "events.jsonl")
    if any("Selected model is at capacity" in message for message in result["errors"]):
        result["blocked_reason"] = "codex-provider-model-capacity"
    if (target / "last.json").exists():
        try:
            result["response"] = load(target / "last.json")
        except (OSError, ValueError):
            result["response_error"] = "Final response is not valid JSON"
    save(target / "control-result.json", result)
    return result


def verify_discovery(result):
    response = result.get("response", {})
    checkpoint = response.get("checkpoint_root")
    return (result["returncode"] == 0 and bool(result["thread_ids"]) and result["source_unchanged"] and
            response.get("workspace") == str(ROOT) and response.get("context_file") == "AGENTS.md" and
            response.get("campaign_contract") == "campaigns/README.md" and isinstance(checkpoint, str) and
            Path(checkpoint) == Path("output/campaigns"))


def discovery(out, timeout):
    schema = {"type": "object", "properties": {key: {"type": "string"} for key in
              ("workspace", "context_file", "campaign_contract", "checkpoint_root")},
              "required": ["workspace", "context_file", "campaign_contract", "checkpoint_root"], "additionalProperties": False}
    prompt = ("Read only AGENTS.md and campaigns/README.md in your workspace. Do not edit files, run models, invoke skills, or change configuration. "
              "Return the absolute workspace path, context_file AGENTS.md, campaign_contract campaigns/README.md and the documented generated checkpoint_root. "
              "This is a read-only discovery proof for the existing campaign implementation.")
    before = source_snapshot()
    process, target, streams = launch(out, "discovery", prompt, "read-only", schema)
    result = finish(process, target, streams, timeout)
    result["source_unchanged"] = before == source_snapshot()
    result["passed"] = verify_discovery(result)
    save(target / "verified.json", result)
    return result


def continue_prompt(base, timeout):
    argv = [sys.executable, str(ROOT / "tools/embctl.py"), "campaign", "run", "--campaign", str(base), "--timeout", str(timeout)]
    return ("Read AGENTS.md and campaigns/README.md. This is an approved checkpoint continuity test using existing human-approved strategy receipts. "
            "Start with exactly the following argv as one command in this workspace: " + json.dumps(argv) + ". "
            "Continue this same campaign until its report, input-required, or an evidenced unresolved limit. "
            "If recovery is needed, read the applicable project skills, actual attempt logs and resource observations. "
            "Approved in-strategy diagnosis, attempt-local patches and campaign retry with recorded reason/hypothesis/change are authorized. "
            "For TEI device evidence use only actual current-attempt runtime observations as required by the existing bench contract. "
            "If evidence is unavailable, preserve an unresolved result; never invent a PASS or user approval. "
            "Mutate execution only through the campaign CLI and let live workers run; do not bypass ownership with standalone build/serve commands. "
            "Do not initialize/reinitialize campaigns, create approvals, answer HITL, edit source/project-configuration/strategy/model files or the checkpoint/declaration, "
            "change declared comparison conditions, or start other work. If human input is required, return input-required immediately. "
            "Return campaign_id, task_state and report path from its JSON. A CLI exit alone is never model PASS.")


def continuity_start(state, resume_existing=False):
    cells = list(state["cells"].values())
    if len(cells) < 3:
        raise ValueError("Continuity proof requires at least three cells.")
    if resume_existing:
        if (cells[0]["phase"] != "done" or cells[0]["outcome"] != "PASS" or not campaign.valid_result(cells[0])
                or campaign.current(state) != cells[1]["id"] or cells[1]["phase"] not in {"build", "serve", "bench"}
                or any(c["phase"] != "prepare" for c in cells[2:])):
            raise ValueError("Resume proof needs a measured completed first cell, an in-progress second cell and remaining cells not started.")
    elif state["active"] or any(c["phase"] != "prepare" for c in cells):
        raise ValueError("Use a new declared campaign, or --resume-existing for an evidenced in-progress second cell.")


def coordinator_matches(argv, cwd, base):
    """Resolve recorded relative --campaign paths before signalling an owner."""
    try:
        script = next(i for i, arg in enumerate(argv) if Path(arg).name == "embctl.py")
        if argv[script + 1:script + 3] != ["campaign", "run"]:
            return False
        target = Path(argv[argv.index("--campaign") + 1])
        return (target if target.is_absolute() else Path(cwd) / target).resolve() == Path(base).resolve()
    except (StopIteration, ValueError, IndexError):
        return False


def continuity(base, out, timeout, phase, resume_existing=False):
    initial = campaign.status(base)
    state = load(base / "checkpoint.json")
    ordered = state["declaration"]["cells"]
    if len(ordered) < 3 or ordered[0]["model_path"] != ordered[1]["model_path"] or ordered[1]["model_path"] == ordered[2]["model_path"]:
        raise ValueError("Declare at least A/condition1, A/condition2, B/condition1 for the live continuity proof.")
    if ordered[0]["comparison"] == ordered[1]["comparison"] and ordered[0]["build"] == ordered[1]["build"]:
        raise ValueError("The two model-A cells must declare different actual comparison conditions or build setups.")
    if any(not c["strategy"] for c in state["cells"].values()):
        raise ValueError("All real model strategies need genuine human-approved receipts before this driver runs.")
    continuity_start(state, resume_existing)
    schema = {"type": "object", "properties": {"campaign_id": {"type": "string"}, "task_state": {"type": "string"},
              "report": {"type": ["string", "null"]}}, "required": ["campaign_id", "task_state", "report"], "additionalProperties": False}
    before = source_snapshot()
    save(out / "continuity-start.json", {"mode": "resume-existing" if resume_existing else "fresh", "status": initial,
                                        "completed_first_cell": state["cells"][ordered[0]["id"]] if resume_existing else None})
    first, first_target, first_streams = launch(out, "call-1", continue_prompt(base, timeout), "workspace-write", schema)
    interrupted = None
    deadline = time.monotonic() + timeout
    try:
        while time.monotonic() < deadline and first.poll() is None:
            snapshot = load(base / "checkpoint.json")
            active = snapshot.get("active")
            if active and active["cell_id"] == ordered[1]["id"] and active["phase"] == phase:
                first_cell = snapshot["cells"][ordered[0]["id"]]
                if first_cell["phase"] != "done" or first_cell["outcome"] != "PASS":
                    raise RuntimeError("First cell lacks completed real verification before interruption.")
                interrupted = {"at": now(), "codex": identity(first.pid), "active": active, "checkpoint_sequence": snapshot["sequence"],
                               "completed_cell": first_cell, "caller": snapshot["invocations"][-1]["caller"]}
                caller = interrupted["caller"]
                matched = False
                if alive(caller):
                    command = Path(f"/proc/{caller['pid']}/cmdline").read_bytes().decode().strip("\0").split("\0")
                    matched = coordinator_matches(command, Path(f"/proc/{caller['pid']}/cwd").resolve(), base)
                interrupted["coordinator_command_matched"] = matched
                save(out / "interruption-before.json", interrupted)
                os.killpg(first.pid, signal.SIGKILL)
                # Unified-exec may own a separate process group. Terminate only
                # the verified coordinator, preserving its finite phase worker.
                if matched and alive(caller):
                    os.kill(caller["pid"], signal.SIGKILL)
                for _ in range(20):
                    if not alive(caller):
                        break
                    time.sleep(.05)
                interrupted["coordinator_confirmed_dead"] = not alive(caller)
                save(out / "interruption-verified.json", interrupted)
                break
            time.sleep(.1)
    finally:
        if interrupted is None and first.poll() is None:
            os.killpg(first.pid, signal.SIGKILL)
        first_result = finish(first, first_target, first_streams, 30)
    if interrupted is None:
        result = {"passed": False, "stage": "interruption-not-reached", "first": first_result, "checkpoint": campaign.status(base),
                  "source_unchanged": before == source_snapshot(), "note": "Inspect actual control/model evidence. No continuity PASS claimed."}
        save(out / "continuity.json", result)
        return result
    after_kill = campaign.status(base)
    save(out / "interruption-after.json", after_kill)
    second, second_target, second_streams = launch(out, "call-2", continue_prompt(base, timeout), "workspace-write", schema)
    second_result = finish(second, second_target, second_streams, timeout + 60)
    final = campaign.status(base)
    final_state = load(base / "checkpoint.json")
    thread_ids = first_result["thread_ids"] + second_result["thread_ids"]
    unchanged_completed = final_state["cells"][ordered[0]["id"]] == interrupted["completed_cell"]
    if resume_existing:
        unchanged_completed = unchanged_completed and interrupted["completed_cell"] == state["cells"][ordered[0]["id"]]
    proof = load(final["report"]) if final.get("report") else None
    result = {"passed": bool(proof and proof["all_cells_passed"] and final["campaign_complete"] and
               second_result["returncode"] == 0 and len(set(thread_ids)) >= 2 and unchanged_completed and
               interrupted["coordinator_confirmed_dead"] and before == source_snapshot()),
              "interruption": interrupted, "after_kill": after_kill, "first": first_result, "second": second_result,
              "distinct_real_codex_threads": list(dict.fromkeys(thread_ids)), "completed_cell_unchanged": unchanged_completed,
              "source_unchanged": before == source_snapshot(), "campaign": final, "model_report": final.get("report"),
              "evidence_kind": "real-codex-exec-and-real-model-api", "fallback_used": "none"}
    result["start_mode"] = "resume-existing" if resume_existing else "fresh"
    save(out / "continuity.json", result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["discovery", "continuity"], default="discovery")
    parser.add_argument("--campaign")
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument("--interrupt-phase", choices=["serve", "bench"], default="serve")
    parser.add_argument("--resume-existing", action="store_true", help="Preserve a measured completed first cell and resume its in-progress second cell")
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("timeout must be positive")
    out = ROOT / "output/validation/campaign-exec" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    out.mkdir(parents=True)
    print(json.dumps({"evidence": str(out), "mode": args.mode}), flush=True)
    if not shutil.which("codex"):
        raise RuntimeError("CODEX_CLI_NOT_FOUND: no fallback is a real Codex invocation.")
    version = subprocess.run(["codex", "--version"], capture_output=True, text=True)
    save(out / "environment.json", {"at": now(), "codex_version": version.stdout, "version_stderr": version.stderr,
                                   "workspace": str(ROOT), "mode": args.mode, "timeout_seconds": args.timeout})
    try:
        smoke = discovery(out, min(args.timeout, 300))
        result = smoke
        if smoke["passed"] and args.mode == "continuity":
            if not args.campaign:
                raise ValueError("continuity requires --campaign")
            result = continuity(Path(args.campaign).resolve(), out, args.timeout, args.interrupt_phase, args.resume_existing)
        save(out / "result.json", result)
        print(json.dumps({"evidence": str(out), "passed": result["passed"], "mode": args.mode}, ensure_ascii=False), flush=True)
        return 0 if result["passed"] else 1
    except Exception as exc:
        save(out / "result.json", {"passed": False, "error": {"type": type(exc).__name__, "message": str(exc)}, "fallback_used": "none"})
        raise


if __name__ == "__main__":
    raise SystemExit(main())
