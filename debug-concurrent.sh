#!/bin/bash
set -e

LOCK_DIR="$HOME/.pick-linear-ticket-locks"

echo "🔍 Running two concurrent picks with detailed output..."
echo ""

# Clean up locks from previous test runs
rm -rf "$LOCK_DIR" 2>/dev/null || true

# Create temp files to capture output
PROC1_OUT=$(mktemp)
PROC1_ERR=$(mktemp)
PROC2_OUT=$(mktemp)
PROC2_ERR=$(mktemp)

trap "rm -f $PROC1_OUT $PROC1_ERR $PROC2_OUT $PROC2_ERR" EXIT

echo "Starting Process 1..."
pick-linear-ticket --team RAN --workspace emberengineering >$PROC1_OUT 2>$PROC1_ERR &
PID1=$!

# Give it a tiny bit of time to start
sleep 0.1

echo "Starting Process 2..."
pick-linear-ticket --team RAN --workspace emberengineering >$PROC2_OUT 2>$PROC2_ERR &
PID2=$!

echo ""
echo "Waiting for both processes to complete..."
wait $PID1 2>/dev/null || true
EXIT1=$?
wait $PID2 2>/dev/null || true
EXIT2=$?

echo ""
echo "════════════════════════════════════════════════════════"
echo "PROCESS 1 (exit code: $EXIT1)"
echo "════════════════════════════════════════════════════════"
echo "STDOUT:"
cat $PROC1_OUT
echo ""
echo "STDERR:"
cat $PROC1_ERR

echo ""
echo "════════════════════════════════════════════════════════"
echo "PROCESS 2 (exit code: $EXIT2)"
echo "════════════════════════════════════════════════════════"
echo "STDOUT:"
cat $PROC2_OUT
echo ""
echo "STDERR:"
cat $PROC2_ERR

echo ""
echo "════════════════════════════════════════════════════════"
echo "LOCK DIRECTORY STATE"
echo "════════════════════════════════════════════════════════"
if [ -d "$LOCK_DIR" ]; then
  ls -la "$LOCK_DIR"
  find "$LOCK_DIR" -type d -ls
else
  echo "Lock directory does not exist"
fi
