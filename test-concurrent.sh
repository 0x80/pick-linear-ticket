#!/bin/bash

LOCK_DIR="$HOME/.pick-linear-ticket-locks"

echo "📋 Running two concurrent pick-linear-ticket commands..."
echo "Lock directory: $LOCK_DIR"
echo ""

# Clean up locks from previous test runs
rm -rf "$LOCK_DIR" 2>/dev/null || true
mkdir -p "$LOCK_DIR"

# Run both commands in parallel, capturing their output and exit codes
{
  echo "=== Process 1 ===" >&2
  pick-linear-ticket --team RAN --workspace emberengineering 2>&1
  echo "Process 1 exit code: $?" >&2
} &
PID1=$!

{
  echo "=== Process 2 ===" >&2
  pick-linear-ticket --team RAN --workspace emberengineering 2>&1
  echo "Process 2 exit code: $?" >&2
} &
PID2=$!

# Wait for both to finish
wait $PID1
EXIT1=$?
wait $PID2
EXIT2=$?

echo ""
echo "📊 Results:"
echo "Process 1 exit code: $EXIT1"
echo "Process 2 exit code: $EXIT2"
echo ""
echo "🔒 Lock directory contents:"
ls -la "$LOCK_DIR" 2>/dev/null || echo "(empty)"
