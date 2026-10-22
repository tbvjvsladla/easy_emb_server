#!/usr/bin/env python3
"""Compatibility entry: use an approved strategy or built attempt."""
import sys
from embctl import main
if __name__ == "__main__":
    raise SystemExit(main(["serve", *sys.argv[1:]]))
