#!/bin/bash
#
# weaver-up — one-command fleet bring-up: resident runner + watch dashboard.
#
#   weaver-up [--no-watch] [--restart] [--print]
#
#   1. ensures a resident headless runner (`weaver run`) is live — the fleet
#      keeps ticking even with no dashboard open; repo .env drives model config;
#   2. opens `weaver watch` in a new Terminal window — a viewer while the
#      headless runner holds the lock; its header already goes red (NO RUNNER /
#      RUNNER STALLED / CODE STALE) the moment any of that is untrue.
#
# Options:
#   --no-watch     skip opening the dashboard
#   --restart      kill the current runner (if any) and start a fresh one — use
#                  after pulling/merging Weaver code: a runner keeps executing
#                  the source it loaded at start
#   --print        print what would run, change nothing
#   -h, --help     this help
#
# The script resolves through symlinks (like bin/weaver.mjs) so it always
# operates on the checkout it lives in. WEAVER_HOME overrides the state dir.

set -euo pipefail

REPO="$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.." && pwd)"
STATE_DIR="${WEAVER_HOME:-$REPO/state}"
RUNNER_LOG="$STATE_DIR/runner.log"
RUN_INTERVAL=5   # the deployed setting; `weaver run` itself defaults to 30

OPEN_WATCH=true
RESTART=false
DRY_RUN=false

usage() {
  cat <<'EOF'
weaver-up — one-command Weaver fleet bring-up (resident runner + watch dashboard)

Usage: weaver-up [--no-watch] [--restart] [--print]

  --no-watch   skip opening the weaver watch dashboard
  --restart    kill the current runner and start a fresh one (use after
               pulling/merging — a runner keeps executing the source it
               loaded at start)
  --print      print what would run, change nothing
  -h, --help   this help
EOF
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --no-watch) OPEN_WATCH=false;;
    --restart) RESTART=true;;
    --print) DRY_RUN=true;;
    -h|--help) usage;;
    --*) echo "❌ unknown flag: $1 (see --help)" >&2; exit 1;;
    *) echo "❌ unexpected argument: $1 (see --help)" >&2; exit 1;;
  esac
  shift
done

run() { if $DRY_RUN; then echo "  [print] $*"; else "$@"; fi; }

runner_pid() {
  # The lock owner file is <pid>-<uuid>.owner.json inside the lock directory —
  # a directory, not a flat file, so `cat` on the lock itself is an error.
  local f
  f="$(ls "$STATE_DIR/.runner.lock"/*.owner.json 2>/dev/null | head -1 || true)"
  if [ -n "$f" ]; then basename "$f" | cut -d- -f1; fi
}

runner_alive() {
  local pid; pid="$(runner_pid)"
  { [ -n "$pid" ] && ps -p "$pid" >/dev/null 2>&1; } || pgrep -f "(weaver|cli[.]ts) run" >/dev/null 2>&1
}

echo "🌐 Weaver fleet: $REPO"

# ── 1. Resident runner ────────────────────────────────────────────────────────
if $RESTART; then
  pid="$(runner_pid)"
  if [ -n "$pid" ] && ps -p "$pid" >/dev/null 2>&1; then
    # ${pid} braced: macOS bash 3.2 folds a multibyte char that directly
    # follows an unbraced name into the variable ("pid…: unbound variable").
    echo "🔁 Restart: stopping runner pid ${pid}…"
    run kill "$pid"
    if ! $DRY_RUN; then
      for _ in $(seq 1 20); do ps -p "$pid" >/dev/null 2>&1 || break; sleep 0.5; done
      if ps -p "$pid" >/dev/null 2>&1; then echo "⚠️  pid $pid did not exit in 10s — continuing anyway" >&2; fi
    fi
  fi
fi

if runner_alive; then
  echo "runner ✓ already live (pid $(runner_pid))"
else
  echo "runner down — starting headless \`weaver run --interval $RUN_INTERVAL\`…"
  if $DRY_RUN; then
    echo "  [print] cd $REPO && nohup weaver run --interval $RUN_INTERVAL >> $RUNNER_LOG 2>&1 & disown"
  else
    mkdir -p "$STATE_DIR"
    (cd "$REPO" && nohup weaver run --interval "$RUN_INTERVAL" >> "$RUNNER_LOG" 2>&1 & disown) || true
    sleep 2
    if runner_alive; then
      echo "runner ✓ started (pid $(runner_pid))"
    else
      echo "❌ runner failed to start — last log lines:" >&2
      tail -5 "$RUNNER_LOG" >&2 || true
      exit 1
    fi
  fi
fi

# Loop health, not just pid health: the runner touches .runner.heartbeat every
# iteration; stale heartbeat + live pid = stalled runner (the dashboard renders
# the same fact in red).
if ! $DRY_RUN && [ -f "$STATE_DIR/.runner.heartbeat" ]; then
  hb_mtime="$(stat -f %m "$STATE_DIR/.runner.heartbeat" 2>/dev/null || stat -c %Y "$STATE_DIR/.runner.heartbeat" 2>/dev/null || echo 0)"
  age=$(( $(date +%s) - hb_mtime ))
  if [ "$age" -gt 120 ]; then
    echo "⚠️  runner heartbeat is ${age}s stale (loop stalled?) — run: weaver-up --restart" >&2
  fi
fi

# ── 2. Watch dashboard ────────────────────────────────────────────────────────
if $OPEN_WATCH; then
  if pgrep -f "(weaver|cli[.]ts) watch" >/dev/null 2>&1; then
    echo "watch ✓ already open"
  elif command -v osascript >/dev/null 2>&1; then
    echo "opening \`weaver watch\` in a new Terminal window…"
    # Non-fatal: the runner is already up; a permission-denied osascript must
    # not abort the script.
    run osascript -e "tell application \"Terminal\" to do script \"cd $REPO && weaver watch\"" \
      || echo "⚠️  could not open a Terminal window (automation permission?) — open \`weaver watch\` yourself" >&2
  else
    echo "⚠️  no osascript (macOS Terminal) — open \`weaver watch\` yourself in another terminal" >&2
  fi
fi

echo "✅ fleet up (runner$( if $OPEN_WATCH; then echo " + watch"; fi))"
