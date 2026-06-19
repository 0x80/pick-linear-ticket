import { mkdir, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { acquireLock, cleanupStaleLocks } from './lock.ts'

describe('concurrent locking', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `lock-concurrent-test-${randomUUID()}`)
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  it('prevents two concurrent processes from acquiring the same lock', async () => {
    const ticketId = 'RAN-999'

    /**
     * Simulate two processes running concurrently:
     * - Both see the same ticket to pick
     * - First one acquires the lock
     * - Second one fails
     */
    const [result1, result2] = await Promise.all([
      acquireLock(ticketId, testDir),
      acquireLock(ticketId, testDir),
    ])

    expect(result1 || result2).toBe(true)
    expect(result1 && result2).toBe(false)
  })

  it('cleans up stale locks before concurrent picks', async () => {
    const ticketId = 'RAN-888'

    /** Simulate a stale lock from a previous crashed process. */
    await acquireLock(ticketId, testDir)

    /** Wait for it to become stale. */
    await new Promise((resolve) => {
      setTimeout(resolve, 1100)
    })

    /** Simulate two processes starting concurrently. */
    /** Process 1 starts and cleans up stale locks. */
    await cleanupStaleLocks(testDir, 1)

    /**
     * Now both processes try to pick the same ticket.
     * The stale lock was cleaned, so both could theoretically acquire it,
     * but the mkdir race condition should prevent that.
     */
    const [result1, result2] = await Promise.all([
      acquireLock(ticketId, testDir),
      acquireLock(ticketId, testDir),
    ])

    expect(result1 || result2).toBe(true)
    expect(result1 && result2).toBe(false)
  })

  it('shows locked ticket in lock directory during pick', async () => {
    const ticketId = 'RAN-777'

    const acquired = await acquireLock(ticketId, testDir)
    expect(acquired).toBe(true)

    const lockedTickets = await readdir(testDir)
    expect(lockedTickets).toContain(ticketId)
  })
})
