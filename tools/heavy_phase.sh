#!/usr/bin/env bash
# Strategy approval authorizes autonomous build/recovery; no per-phase approval tokens.
set -euo pipefail
exec node "$(dirname "${BASH_SOURCE[0]}")/embctl.ts" build "$@"
