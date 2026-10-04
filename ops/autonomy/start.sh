#!/bin/sh
set -eu

REPO=/projects/axyvero-web
STATE=/opt/data/axyvero
RUNNER_DIR=$STATE/runner-source
BRANCH=automation/axy-autonomous-loop
PIDFILE=$STATE/runner.pid
LOGFILE=$STATE/runner.log

mkdir -p "$STATE"

git -C "$REPO" fetch origin "$BRANCH:refs/remotes/origin/$BRANCH"
DESIRED="$(git -C "$REPO" rev-parse "origin/$BRANCH")"

if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    CURRENT="$(git -C "$RUNNER_DIR" rev-parse HEAD 2>/dev/null || true)"
    if [ "$CURRENT" = "$DESIRED" ]; then
      echo "AXYVERO_AUTONOMY=ALREADY_RUNNING"
      echo "PID=$PID"
      echo "SOURCE=$CURRENT"
      echo "LOG=$LOGFILE"
      exit 0
    fi
    echo "AXYVERO_AUTONOMY=RESTARTING"
    kill "$PID" 2>/dev/null || true
    i=0
    while kill -0 "$PID" 2>/dev/null && [ "$i" -lt 20 ]; do
      sleep 1
      i=$((i + 1))
    done
    if kill -0 "$PID" 2>/dev/null; then
      kill -9 "$PID" 2>/dev/null || true
    fi
  fi
  rm -f "$PIDFILE"
fi

if [ -d "$RUNNER_DIR" ]; then
  git -C "$REPO" worktree remove --force "$RUNNER_DIR" 2>/dev/null || true
  rm -rf "$RUNNER_DIR"
fi

git -C "$REPO" worktree add --detach "$RUNNER_DIR" "$DESIRED"

nohup node "$RUNNER_DIR/ops/autonomy/runner.mjs" >>"$LOGFILE" 2>&1 &
PID=$!
echo "$PID" > "$PIDFILE"

echo "AXYVERO_AUTONOMY=STARTED"
echo "PID=$PID"
echo "SOURCE=$DESIRED"
echo "LOG=$LOGFILE"
