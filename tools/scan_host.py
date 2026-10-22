#!/usr/bin/env python3
"""Compatibility entry: current node initialization writes manifest.yaml."""
import sys
from embctl import main
if __name__ == "__main__":
    raise SystemExit(main(["init", *sys.argv[1:]]))
