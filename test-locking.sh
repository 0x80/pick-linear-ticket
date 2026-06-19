#!/bin/bash
set -e

LOCK_DIR="$HOME/.pick-linear-ticket-locks"
TEST_TICKET="TEST-CONCURRENT-123"
TEST_LOCK_DIR="${LOCK_DIR}/concurrent-test-$$"

echo "🔍 Testing file-based locking mechanism..."
echo "Lock directory: $TEST_LOCK_DIR"

# Test 1: Basic lock acquisition
echo ""
echo "Test 1: Basic lock acquisition"
if mkdir -p "$TEST_LOCK_DIR" && mkdir "$TEST_LOCK_DIR/$TEST_TICKET" 2>/dev/null; then
  echo "✓ First lock acquisition succeeded"
else
  echo "✗ First lock acquisition failed"
  exit 1
fi

# Test 2: Concurrent lock failure
echo ""
echo "Test 2: Concurrent lock (should fail)"
if mkdir "$TEST_LOCK_DIR/$TEST_TICKET" 2>/dev/null; then
  echo "✗ Second lock acquisition succeeded (BUG: should have failed!)"
  rm -rf "$TEST_LOCK_DIR"
  exit 1
else
  echo "✓ Second lock acquisition failed as expected"
fi

# Test 3: Lock cleanup
echo ""
echo "Test 3: Lock cleanup"
rm -rf "$TEST_LOCK_DIR/$TEST_TICKET"
if mkdir "$TEST_LOCK_DIR/$TEST_TICKET" 2>/dev/null; then
  echo "✓ Lock reacquired after cleanup"
else
  echo "✗ Lock cleanup failed"
  exit 1
fi

# Test 4: Check actual lock directory
echo ""
echo "Test 4: Check actual lock directory"
ls -la "$TEST_LOCK_DIR/" || true
rm -rf "$TEST_LOCK_DIR"

echo ""
echo "✓ All locking tests passed!"
