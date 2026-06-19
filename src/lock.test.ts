/**
 * Tests for the file-system lock. The headline guarantee is in
 * `claimFirstAvailable`: two pickers racing over the same ranked list must end
 * up on different tickets. The earlier implementation released its lock on exit
 * and never fanned out, so two near-simultaneous runs both picked the top
 * ticket — these tests pin down the corrected behavior.
 */

import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireLock, claimFirstAvailable, cleanupStaleLocks, releaseLock } from './lock.ts'

describe('lock', () => {
  let lockDir: string

  beforeEach(async () => {
    lockDir = join(tmpdir(), `pick-lock-test-${randomUUID()}`)
    await mkdir(lockDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true })
  })

  describe('acquireLock', () => {
    it('grants the lock to the first caller and denies the second', async () => {
      expect(await acquireLock('RAN-1', lockDir)).toBe(true)
      expect(await acquireLock('RAN-1', lockDir)).toBe(false)
    })

    it('grants the lock again once released', async () => {
      expect(await acquireLock('RAN-1', lockDir)).toBe(true)
      await releaseLock('RAN-1', lockDir)
      expect(await acquireLock('RAN-1', lockDir)).toBe(true)
    })

    it('lets exactly one of two concurrent callers win the same ticket', async () => {
      const [first, second] = await Promise.all([
        acquireLock('RAN-1', lockDir),
        acquireLock('RAN-1', lockDir),
      ])
      /** Exactly one true, one false — never both. */
      expect(first).not.toBe(second)
    })
  })

  describe('claimFirstAvailable', () => {
    const ranked = [{ identifier: 'RAN-1' }, { identifier: 'RAN-2' }, { identifier: 'RAN-3' }]

    it('claims the top ticket when nothing is locked', async () => {
      const claim = await claimFirstAvailable(ranked, lockDir)
      expect(claim?.chosen.identifier).toBe('RAN-1')
      expect(claim?.lockedAhead).toBe(0)
    })

    it('skips already-claimed tickets and reports how many it skipped', async () => {
      await acquireLock('RAN-1', lockDir)
      await acquireLock('RAN-2', lockDir)

      const claim = await claimFirstAvailable(ranked, lockDir)
      expect(claim?.chosen.identifier).toBe('RAN-3')
      expect(claim?.lockedAhead).toBe(2)
    })

    it('returns null when every ticket is already claimed', async () => {
      await acquireLock('RAN-1', lockDir)
      await acquireLock('RAN-2', lockDir)
      await acquireLock('RAN-3', lockDir)

      expect(await claimFirstAvailable(ranked, lockDir)).toBeNull()
    })

    it('fans two concurrent pickers out to different tickets', async () => {
      /** The exact scenario the user hit: two runs over the same ranked list. */
      const [a, b] = await Promise.all([
        claimFirstAvailable(ranked, lockDir),
        claimFirstAvailable(ranked, lockDir),
      ])
      expect(a).not.toBeNull()
      expect(b).not.toBeNull()
      expect(a?.chosen.identifier).not.toBe(b?.chosen.identifier)
    })

    it('fans three concurrent pickers out to three distinct tickets', async () => {
      const claims = await Promise.all([
        claimFirstAvailable(ranked, lockDir),
        claimFirstAvailable(ranked, lockDir),
        claimFirstAvailable(ranked, lockDir),
      ])
      const chosen = claims.map((c) => c?.chosen.identifier)
      expect(new Set(chosen)).toEqual(new Set(['RAN-1', 'RAN-2', 'RAN-3']))
    })
  })

  describe('cleanupStaleLocks', () => {
    it('removes a lock older than the threshold', async () => {
      await acquireLock('RAN-1', lockDir)
      await new Promise((resolve) => {
        setTimeout(resolve, 1100)
      })

      await cleanupStaleLocks(lockDir, 1)

      /** The stale lock is gone, so it can be claimed again. */
      expect(await acquireLock('RAN-1', lockDir)).toBe(true)
    })

    it('keeps a lock younger than the threshold', async () => {
      await acquireLock('RAN-1', lockDir)

      await cleanupStaleLocks(lockDir, 30)

      /** Fresh lock survives, so a re-claim is denied. */
      expect(await acquireLock('RAN-1', lockDir)).toBe(false)
    })

    it('is a no-op when the lock directory does not exist', async () => {
      const missing = join(tmpdir(), `pick-lock-missing-${randomUUID()}`)
      await expect(cleanupStaleLocks(missing, 30)).resolves.toBeUndefined()
    })
  })
})
