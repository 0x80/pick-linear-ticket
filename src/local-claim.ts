import { execa } from 'execa'

/**
 * Per-subprocess deadline for the git calls below. Both are local repository
 * reads that answer in milliseconds; anything slower means a wedged git (a
 * stale index lock, a network-backed filesystem) and we'd rather fall through
 * to "no claims detected" than hang the pick.
 */
const GIT_TIMEOUT_MS = 5000

/**
 * Evidence that a ticket's branch already exists in the local repository.
 * `worktreePath` is present when the branch is checked out in a worktree, which
 * is the stronger signal: a worktree usually means an agent or a person is
 * working the ticket right now.
 */
export type LocalClaim = {
  branchName: string
  /** Absolute path of the worktree holding this branch, when there is one. */
  worktreePath?: string
}

/** Local claims keyed by branch name. */
export type LocalClaims = ReadonlyMap<string, LocalClaim>

/**
 * Runs a git command in `cwd`, returning `null` instead of throwing when git
 * fails for any reason. Every caller here treats failure as "we cannot tell",
 * which must never be fatal: the picker is a global CLI and is legitimately
 * run from directories that aren't git repositories at all.
 */
async function runGit(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execa('git', args, { cwd, timeout: GIT_TIMEOUT_MS })
    return stdout
  } catch {
    return null
  }
}

/**
 * Parses `git worktree list --porcelain` into a branch -> worktree-path map.
 *
 * The format is stanza-per-worktree, blank-line separated, where `worktree` is
 * always the first line of a stanza and `branch` is present only when that
 * worktree has a branch checked out (a detached HEAD has none).
 */
function parseWorktrees(stdout: string): Map<string, string> {
  const result = new Map<string, string>()
  let currentPath: string | undefined

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length).trim()
      continue
    }
    if (line.startsWith('branch ') && currentPath !== undefined) {
      const ref = line.slice('branch '.length).trim()
      const branchName = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
      result.set(branchName, currentPath)
    }
  }

  return result
}

/**
 * Collects the branches that already exist in the repository at `cwd`, from two
 * sources: worktree checkouts and plain local branches. This is the picker's
 * only claim signal that does not depend on Linear being reachable, fresh, or
 * consistent — which is exactly why it exists. A ticket whose branch is already
 * checked out has an owner regardless of what the issue's state field says.
 *
 * Remote branches are deliberately not consulted: `origin/*` reflects whatever
 * was last fetched, so it both misses fresh work and lingers after a merged
 * branch is deleted. Local worktrees and branches are the signals that are
 * true right now on this machine.
 *
 * Failure is per-probe, and a partial result is returned on purpose: if the
 * branch read fails but the worktree read succeeds, the worktree claims are
 * still reported. Claims are purely additive — every entry is a branch that
 * really exists — so a partial answer can only ever catch *fewer* claims than
 * a complete one, never invent a false one. Discarding it would turn a
 * half-failed read into a guard that detects nothing, which is the fail-open
 * behavior this module was written to remove. Both probes failing (not a git
 * repository, git missing) therefore yields an empty map, which is the honest
 * "cannot tell" answer rather than a manufactured one.
 */
export async function readLocalClaims(cwd: string = process.cwd()): Promise<LocalClaims> {
  const [worktreeStdout, branchStdout] = await Promise.all([
    runGit(['worktree', 'list', '--porcelain'], cwd),
    runGit(['branch', '--list', '--format=%(refname:short)'], cwd),
  ])

  const claims = new Map<string, LocalClaim>()

  if (branchStdout !== null) {
    for (const line of branchStdout.split('\n')) {
      const branchName = line.trim()
      if (branchName.length > 0) {
        claims.set(branchName, { branchName })
      }
    }
  }

  if (worktreeStdout !== null) {
    for (const [branchName, worktreePath] of parseWorktrees(worktreeStdout)) {
      /** A worktree outranks a bare branch, so it overwrites any entry set above. */
      claims.set(branchName, { branchName, worktreePath })
    }
  }

  return claims
}

/**
 * Escapes the regex metacharacters that can appear in a Linear identifier.
 * Identifiers match `<KEY>-<N>`, so in practice this is the `-`, but escaping
 * defensively keeps {@link branchClaimsTicket} correct if the shape widens.
 */
function escapeForRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\-]/g, '\\$&')
}

/**
 * Returns true when `branchName` belongs to `identifier`.
 *
 * Matching is on the **ticket identifier**, never on the branch name the
 * picker would generate today. A branch name is `<id>-<title-slug>`, so a
 * title edit in Linear changes the generated name while the branch on disk
 * keeps the old slug — matching on the generated name would silently stop
 * recognizing a branch that is plainly the ticket's, which is the entire
 * failure this guard exists to prevent.
 *
 * The identifier must appear as a delimited segment: not preceded by another
 * alphanumeric, and not followed by a digit. The trailing-digit rule is what
 * keeps `RAN-19` from claiming `ran-1947-foo`, and the leading rule lets a
 * prefixed convention like `thijs/0521-ran-74-slug` still match.
 */
export function branchClaimsTicket(branchName: string, identifier: string): boolean {
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeForRegex(identifier.toLowerCase())}([^0-9]|$)`)
  return pattern.test(branchName.toLowerCase())
}

/**
 * Finds the claim on `identifier`, if any. A worktree claim wins over a bare
 * branch when both match, so the message the user gets names the checked-out
 * path rather than an incidental leftover branch.
 */
export function findLocalClaim(claims: LocalClaims, identifier: string): LocalClaim | undefined {
  let fallback: LocalClaim | undefined

  for (const claim of claims.values()) {
    if (!branchClaimsTicket(claim.branchName, identifier)) continue
    if (claim.worktreePath !== undefined) return claim
    fallback ??= claim
  }

  return fallback
}

/**
 * Renders a claim as a one-line explanation for the user, naming the worktree
 * path when there is one so they can go look at what is already running.
 */
export function describeLocalClaim(claim: LocalClaim): string {
  return claim.worktreePath === undefined
    ? `local branch '${claim.branchName}' already exists`
    : `branch '${claim.branchName}' is already checked out at ${claim.worktreePath}`
}
