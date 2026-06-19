import { mkdir, rm, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Attempts to claim `ticketId` by creating a directory named after it inside
 * `lockDir`. `mkdir` is atomic on every POSIX filesystem and Windows: exactly
 * one caller can create a given path, so two processes racing for the same
 * ticket can never both win. Returns `true` if we created the lock, `false`
 * if it already existed (another process holds it).
 *
 * The lock is a *claim* that outlives this process — it is intentionally NOT
 * released when the picker exits. It is freed only by {@link cleanupStaleLocks}
 * (the staleness timeout) or an explicit {@link releaseLock} on a failure path.
 * Releasing on exit would defeat the purpose: the next concurrent picker, a few
 * milliseconds behind, would find the lock already gone and pick the same
 * ticket.
 */
export async function acquireLock(ticketId: string, lockDir: string): Promise<boolean> {
  await mkdir(lockDir, { recursive: true })
  try {
    await mkdir(join(lockDir, ticketId))
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    /** EEXIST means another process already holds the lock — not a failure. */
    if (code === 'EEXIST') {
      return false
    }
    throw error
  }
}

/**
 * Walks `ranked` in preference order and claims the first ticket whose lock is
 * free. This is what makes concurrent invocations fan out: if the top ticket is
 * already claimed by a sibling process, we move on to the next-best one instead
 * of failing. Returns the claimed candidate plus how many higher-ranked tickets
 * were already locked, or `null` if every candidate is claimed.
 *
 * Acquisition is sequential (not `Promise.all`) so we always claim the
 * highest-ranked free ticket and never grab more than one.
 */
export async function claimFirstAvailable<T extends { identifier: string }>(
  ranked: readonly T[],
  lockDir: string,
): Promise<{ chosen: T; lockedAhead: number } | null> {
  let lockedAhead = 0
  for (const candidate of ranked) {
    if (await acquireLock(candidate.identifier, lockDir)) {
      return { chosen: candidate, lockedAhead }
    }
    lockedAhead += 1
  }
  return null
}

/**
 * Releases a previously acquired lock. Only used on failure paths (e.g. a
 * `--start` transition that errored after we claimed the ticket) so the ticket
 * isn't stranded until the staleness timeout. A missing lock (`ENOENT`) is a
 * no-op.
 */
export async function releaseLock(ticketId: string, lockDir: string): Promise<void> {
  try {
    await rm(join(lockDir, ticketId), { recursive: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
}

/**
 * Removes locks older than `stalenessThresholdSeconds`, measured by the lock
 * directory's mtime (its creation time). This is the crash-recovery mechanism:
 * if a picker dies after claiming a ticket but before the work is under way,
 * the stale claim is reclaimed on the next run rather than wedging the ticket
 * forever. Per-entry errors are swallowed so one bad lock can't abort the sweep.
 */
export async function cleanupStaleLocks(
  lockDir: string,
  stalenessThresholdSeconds: number,
): Promise<void> {
  let entries: string[]
  try {
    await mkdir(lockDir, { recursive: true })
    entries = await readdir(lockDir)
  } catch {
    /** No lock directory (or unreadable) means nothing to clean up. */
    return
  }

  const now = Date.now()
  for (const entry of entries) {
    try {
      const entryPath = join(lockDir, entry)
      const stats = await stat(entryPath)
      const ageSeconds = (now - stats.mtimeMs) / 1000
      if (ageSeconds > stalenessThresholdSeconds) {
        await rm(entryPath, { recursive: true })
      }
    } catch {
      /** A lock removed by another process mid-sweep is fine; skip it. */
    }
  }
}
