import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { acquireLock, releaseLock, cleanupStaleLocks } from './lock.ts'

describe('locking', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `lock-test-${randomUUID()}`)
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  it('acquires and releases a lock', async () => {
    const ticketId = 'RAN-123'

    const acquired = await acquireLock(ticketId, testDir)
    expect(acquired).toBe(true)

    await releaseLock(ticketId, testDir)
  })

  it('prevents duplicate locks', async () => {
    const ticketId = 'RAN-123'

    const first = await acquireLock(ticketId, testDir)
    expect(first).toBe(true)

    const second = await acquireLock(ticketId, testDir)
    expect(second).toBe(false)

    await releaseLock(ticketId, testDir)
  })

  it('allows new lock after release', async () => {
    const ticketId = 'RAN-123'

    const first = await acquireLock(ticketId, testDir)
    expect(first).toBe(true)

    await releaseLock(ticketId, testDir)

    const second = await acquireLock(ticketId, testDir)
    expect(second).toBe(true)

    await releaseLock(ticketId, testDir)
  })

  it('cleans up stale locks', async () => {
    const ticketId = 'RAN-456'

    await acquireLock(ticketId, testDir)

    /** Wait a bit and then clean up locks older than 1 second. */
    await new Promise((resolve) => {
      setTimeout(resolve, 1100)
    })
    await cleanupStaleLocks(testDir, 1)

    /** Lock should be gone, so we can acquire it again. */
    const acquired = await acquireLock(ticketId, testDir)
    expect(acquired).toBe(true)

    await releaseLock(ticketId, testDir)
  })
})
