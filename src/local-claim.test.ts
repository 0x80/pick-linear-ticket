/**
 * Tests for the local-claim probe. This is the picker's only guard that keeps
 * working when Linear is degraded and serving stale issue states, so the cases
 * that matter most are the negative ones: it must never throw, and must degrade
 * to "no claims" rather than to a crash, whatever it is pointed at.
 */

import { execa } from 'execa'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { describeLocalClaim, readLocalClaims } from './local-claim.ts'

/**
 * Spawning real git is the point of this suite — a mocked git would only
 * re-assert the parser against strings we made up. Real repositories are cheap
 * but not free, so the whole file gets a wider deadline than Vitest's default.
 */
const GIT_TEST_TIMEOUT_MS = 30_000

/** Creates a repository with one commit, which is the minimum a branch needs. */
async function initRepo(root: string): Promise<void> {
  await mkdir(root, { recursive: true })
  await execa('git', ['init', '--initial-branch=main'], { cwd: root })
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  await execa('git', ['config', 'user.name', 'Test'], { cwd: root })
  await writeFile(join(root, 'readme.md'), '# test\n')
  await execa('git', ['add', '.'], { cwd: root })
  await execa('git', ['commit', '-m', 'initial'], { cwd: root })
}

describe('local-claim', () => {
  let root: string

  beforeEach(() => {
    root = join(tmpdir(), `pick-claim-test-${randomUUID()}`)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  describe('readLocalClaims', () => {
    it(
      'reports no claims for a directory that is not a git repository',
      async () => {
        await mkdir(root, { recursive: true })
        const claims = await readLocalClaims(root)
        expect(claims.size).toBe(0)
      },
      GIT_TEST_TIMEOUT_MS,
    )

    it(
      'reports no claims for a path that does not exist at all',
      async () => {
        const claims = await readLocalClaims(join(root, 'nope'))
        expect(claims.size).toBe(0)
      },
      GIT_TEST_TIMEOUT_MS,
    )

    it(
      'finds a plain local branch with no worktree',
      async () => {
        await initRepo(root)
        await execa('git', ['branch', 'ran-1-do-a-thing'], { cwd: root })

        const claims = await readLocalClaims(root)
        const claim = claims.get('ran-1-do-a-thing')

        expect(claim?.branchName).toBe('ran-1-do-a-thing')
        expect(claim?.worktreePath).toBeUndefined()
      },
      GIT_TEST_TIMEOUT_MS,
    )

    it(
      'finds a branch checked out in a worktree and reports its path',
      async () => {
        await initRepo(root)
        const worktreePath = join(root, '.worktrees', 'ran-2-other-thing')
        await execa('git', ['worktree', 'add', '-b', 'ran-2-other-thing', worktreePath, 'HEAD'], {
          cwd: root,
        })

        const claims = await readLocalClaims(root)
        const claim = claims.get('ran-2-other-thing')

        expect(claim?.branchName).toBe('ran-2-other-thing')
        /** Compare the basename: macOS resolves /var and /private/var differently. */
        expect(claim?.worktreePath).toContain('ran-2-other-thing')
      },
      GIT_TEST_TIMEOUT_MS,
    )

    it(
      'prefers the worktree signal over the bare-branch one for the same branch',
      async () => {
        await initRepo(root)
        const worktreePath = join(root, '.worktrees', 'ran-3-both')
        await execa('git', ['worktree', 'add', '-b', 'ran-3-both', worktreePath, 'HEAD'], {
          cwd: root,
        })

        /**
         * A worktree branch also shows up in `git branch --list`, so this pins
         * down that the richer entry wins rather than being overwritten by the
         * bare one depending on which read lands last.
         */
        const claims = await readLocalClaims(root)
        expect(claims.get('ran-3-both')?.worktreePath).toBeDefined()
      },
      GIT_TEST_TIMEOUT_MS,
    )

    it(
      'does not claim a branch name that was never created',
      async () => {
        await initRepo(root)
        const claims = await readLocalClaims(root)
        expect(claims.get('ran-99-never-existed')).toBeUndefined()
      },
      GIT_TEST_TIMEOUT_MS,
    )

    it(
      'sees claims when run from inside a worktree rather than the main checkout',
      async () => {
        await initRepo(root)
        const worktreePath = join(root, '.worktrees', 'ran-4-from-inside')
        await execa('git', ['worktree', 'add', '-b', 'ran-4-from-inside', worktreePath, 'HEAD'], {
          cwd: root,
        })

        /**
         * The picker is routinely invoked from inside a worktree. Git reports the
         * whole worktree set from any member, so the guard must hold there too.
         */
        const claims = await readLocalClaims(worktreePath)
        expect(claims.get('ran-4-from-inside')?.worktreePath).toBeDefined()
      },
      GIT_TEST_TIMEOUT_MS,
    )
  })

  describe('describeLocalClaim', () => {
    it('names the worktree path when the branch is checked out', () => {
      const message = describeLocalClaim({ branchName: 'ran-5-x', worktreePath: '/tmp/wt' })
      expect(message).toContain('/tmp/wt')
      expect(message).toContain('ran-5-x')
    })

    it('describes a bare branch without inventing a path', () => {
      const message = describeLocalClaim({ branchName: 'ran-6-y' })
      expect(message).toContain('ran-6-y')
      expect(message).not.toContain('checked out')
    })
  })
})
