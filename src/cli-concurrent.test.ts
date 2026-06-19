import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { acquireLock, cleanupStaleLocks } from './lock.ts'

/**
 * This test simulates two concurrent processes picking a ticket:
 * 1. Both processes see the same ticket as the best choice
 * 2. Both try to acquire the lock
 * 3. Only one should succeed
 *
 * This mirrors the actual CLI behavior where two `pick-linear-ticket`
 * invocations happen at the same time.
 */
describe('CLI concurrent picking', () => {
  let testLockDir: string

  beforeEach(async () => {
    testLockDir = join(tmpdir(), `cli-concurrent-test-${randomUUID()}`)
    await mkdir(testLockDir, { recursive: true })
  })

  afterEach(async () => {
    try {
      await rm(testLockDir, { recursive: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  it('only one of two concurrent processes can pick the same ticket', async () => {
    const pickedTicketId = 'RAN-123'

    /**
     * Simulate the exact sequence:
     * 1. Both processes call main() and cleanupStaleLocks()
     * 2. Both independently pick the same ticket
     * 3. Both try to acquire the lock at roughly the same time
     */
    await cleanupStaleLocks(testLockDir, 30)

    const [process1, process2] = await Promise.all([
      /**
       * Process 1: pick the ticket and try to acquire lock
       */
      (async () => {
        const lockAcquired = await acquireLock(pickedTicketId, testLockDir)
        return { processId: 1, lockAcquired, ticket: pickedTicketId }
      })(),

      /**
       * Process 2: pick the same ticket and try to acquire lock
       */
      (async () => {
        const lockAcquired = await acquireLock(pickedTicketId, testLockDir)
        return { processId: 2, lockAcquired, ticket: pickedTicketId }
      })(),
    ])

    /**
     * Verify that exactly one process acquired the lock
     */
    expect(process1.lockAcquired || process2.lockAcquired).toBe(true)
    expect(process1.lockAcquired && process2.lockAcquired).toBe(false)

    /**
     * One should succeed, one should fail
     */
    const successfulProcess = process1.lockAcquired ? 1 : 2
    const failedProcess = process1.lockAcquired ? 2 : 1
    expect(successfulProcess).toBeGreaterThanOrEqual(1)
    expect(failedProcess).toBeGreaterThanOrEqual(1)
  })

  it('concurrent processes with stale lock cleanup still prevent double picks', async () => {
    const pickedTicketId = 'RAN-456'

    /**
     * Simulate a stale lock from a previous run
     */
    await acquireLock(pickedTicketId, testLockDir)
    await new Promise((resolve) => {
      setTimeout(resolve, 1100)
    })

    /**
     * Both processes start and clean up stale locks
     */
    await Promise.all([cleanupStaleLocks(testLockDir, 1), cleanupStaleLocks(testLockDir, 1)])

    /**
     * Both processes try to pick the same ticket
     */
    const [process1, process2] = await Promise.all([
      acquireLock(pickedTicketId, testLockDir),
      acquireLock(pickedTicketId, testLockDir),
    ])

    /**
     * Still only one should succeed, even after cleanup
     */
    expect(process1 || process2).toBe(true)
    expect(process1 && process2).toBe(false)
  })

  it('can acquire different tickets concurrently', async () => {
    /**
     * Multiple processes picking different tickets should all succeed
     */
    const [result1, result2, result3] = await Promise.all([
      acquireLock('RAN-111', testLockDir),
      acquireLock('RAN-222', testLockDir),
      acquireLock('RAN-333', testLockDir),
    ])

    expect(result1).toBe(true)
    expect(result2).toBe(true)
    expect(result3).toBe(true)
  })
})
