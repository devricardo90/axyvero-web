#!/bin/sh
set -eu

REPO=/projects/axyvero-web
STATE=/opt/data/axyvero
RUNNER_DIR=$STATE/runner-source
BRANCH=automation/axy-autonomous-loop
PIDFILE=$STATE/runner.pid
LOGFILE=$STATE/runner.log

mkdir -p "$STATE"

if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "AXYVERO_AUTONOMY=ALREADY_RUNNING"
    echo "PID=$PID"
    echo "LOG=$LOGFILE"
    exit 0
  fi
  rm -f "$PIDFILE"
fi

git -C "$REPO" fetch origin "$BRANCH:refs/remotes/origin/$BRANCH"

if [ -d "$RUNNER_DIR" ]; then
  git -C "$REPO" worktree remove --force "$RUNNER_DIR" 2>/dev/null || true
  rm -rf "$RUNNER_DIR"
fi

git -C "$REPO" worktree add --detach "$RUNNER_DIR" "origin/$BRANCH"

nohup node "$RUNNER_DIR/ops/autonomy/runner.mjs" >>"$LOGFILE" 2>&1 &
PID=$!
echo "$PID" > "$PIDFILE"

echo "AXYVERO_AUTONOMY=STARTED"
echo "PID=$PID"
echo "LOG=$LOGFILE"
