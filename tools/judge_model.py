#!/usr/bin/env python3
"""Compatibility entry: inspect metadata; engine selection follows manifest/HITL."""
import sys
from embctl import main
if __name__ == "__main__":
    raise SystemExit(main(["inspect", *sys.argv[1:]]))
