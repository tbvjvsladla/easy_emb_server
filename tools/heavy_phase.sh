#!/usr/bin/env bash
# Strategy approval authorizes autonomous build/recovery; no per-phase approval tokens.
set -euo pipefail
exec python3 "$(dirname "${BASH_SOURCE[0]}")/embctl.py" build "$@"
