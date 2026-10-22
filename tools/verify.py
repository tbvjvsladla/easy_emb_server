#!/usr/bin/env python3
"""Run fixed project checks without shell redirection or wildcard command strings."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", choices=["all", "python", "wiki"], default="all")
    args = parser.parse_args()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    out = ROOT / "output/validation/verify" / stamp
    out.mkdir(parents=True)
    sources = {"python": sorted((ROOT / "tests").rglob("test*.py")),
               "wiki": sorted((ROOT / ".agents/skills/wiki-desk/tests").glob("*.test.ts"))}
    commands = {"python": [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"],
                "wiki": [shutil.which("node") or "node", "--test", *map(str, sources["wiki"])]}
    results = []
    for suite in (commands if args.suite == "all" else [args.suite]):
        log = out / (suite + ".log")
        record = {"suite": suite, "command": commands[suite], "log": str(log), "status": "running"}
        results.append(record)
        (out / "result.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
        if not sources[suite]:
            message = "Local test sources are absent; tests/ is not distributed. No tests were run."
            record.update(status="UNAVAILABLE", error=message)
            log.write_text(message + "\n")
        else:
            try:
                with log.open("w") as stream:
                    p = subprocess.run(commands[suite], cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT, timeout=300)
                record.update(status="PASS" if p.returncode == 0 else "FAIL", returncode=p.returncode)
            except (OSError, subprocess.TimeoutExpired) as exc:
                record.update(status="FAIL", error=str(exc))
        (out / "result.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(record, ensure_ascii=False), flush=True)
    if any(r["status"] == "FAIL" for r in results):
        return 1
    return 2 if any(r["status"] == "UNAVAILABLE" for r in results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
