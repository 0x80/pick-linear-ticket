import { mkdir, rm, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Acquire a lock for a ticket. Returns true if lock was obtained, false if already locked. */
export async function acquireLock(ticketId: string, lockDir: string): Promise<boolean> {
  try {
    await mkdir(lockDir, { recursive: true })
    const lockPath = join(lockDir, ticketId)
    await mkdir(lockPath)
    return true
  } catch (error) {
    /** Only return false if the directory already exists (EEXIST). Rethrow other errors. */
    const err = error as NodeJS.ErrnoException
    if (err.code === 'EEXIST') {
      return false
    }
    throw error
  }
}

/** Release a lock for a ticket. */
export async function releaseLock(ticketId: string, lockDir: string): Promise<void> {
  try {
    const lockPath = join(lockDir, ticketId)
    await rm(lockPath, { recursive: true })
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    /** Ignore ENOENT (file doesn't exist) - that's fine. Rethrow other errors. */
    if (err.code !== 'ENOENT') {
      throw error
    }
  }
}

/** Clean up locks older than the specified threshold (in seconds). */
export async function cleanupStaleLocks(
  lockDir: string,
  stalenessThresholdSeconds: number,
): Promise<void> {
  try {
    await mkdir(lockDir, { recursive: true })
    const now = Date.now()
    const files = await readdir(lockDir)

    for (const file of files) {
      try {
        const filePath = join(lockDir, file)
        const stats = await stat(filePath)
        const ageSeconds = (now - stats.mtimeMs) / 1000
        if (ageSeconds > stalenessThresholdSeconds) {
          await rm(filePath, { recursive: true })
        }
      } catch {
        // Ignore errors on individual files
      }
    }
  } catch {
    // If lock dir doesn't exist or we can't read it, that's fine
  }
}
