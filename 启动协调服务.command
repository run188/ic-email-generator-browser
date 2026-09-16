#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SERVER="$ROOT/coordinator/server.py"
AUTOMATION_ROOT="$(cd "$ROOT/../ios-automation" && pwd)"
LOG_DIR="$AUTOMATION_ROOT/logs"
mkdir -p "$LOG_DIR"

if curl --silent --fail http://127.0.0.1:8765/api/health >/dev/null 2>&1; then
  exit 0
fi

export IC_PRIVACY_AUTOMATION_ROOT="$AUTOMATION_ROOT"
nohup python3 "$SERVER" >>"$LOG_DIR/coordinator.log" 2>&1 &

for _ in {1..40}; do
  if curl --silent --fail http://127.0.0.1:8765/api/health >/dev/null 2>&1; then
    exit 0
  fi
  sleep 0.25
done

echo "协调服务启动失败，请检查 $LOG_DIR/coordinator.log" >&2
exit 1
