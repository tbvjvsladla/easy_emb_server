#!/usr/bin/env python3
"""Run the fixed local Codex review without accepting CLI configuration overrides."""
import argparse
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args(argv)
    os.chdir(ROOT)
    os.execvp("codex", ["codex", "review", "--uncommitted"])


if __name__ == "__main__":
    main()
