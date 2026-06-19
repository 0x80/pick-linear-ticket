#!/usr/bin/env node
import { consola } from 'consola'
import meow from 'meow'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  LINEAR_CLI_INSTALL_URL,
  type LinearConfig,
  LinearCliMissingError,
  WorkspaceMismatchError,
  activeCycleIdentifiers,
  activeSetRelations,
  createdAtFor,
  getIssue,
  listAllIssues,
  preflight,
  startIssue,
  whoami,
} from './linear-cli.ts'
import { claimFirstAvailable, cleanupStaleLocks, releaseLock } from './lock.ts'
import { PRIORITY_LABELS, buildReason, rankCandidates } from './rank.ts'
import { TimeoutError, withTimeout } from './timeout.ts'
import { buildBranchName } from './slug.ts'
import type { Candidate, Identifier } from './types.ts'
import { MISSING_CREATED_AT, isIdentifier } from './types.ts'

const cli = meow(
  `
  Usage
    $ pick-linear-ticket [TICKET_ID] --team <key> --workspace <slug> [options]

  Required
    --team       Linear team key (e.g. RAN).
    --workspace  Linear workspace URL slug (e.g. emberengineering).

  Options
    --start      Transition the chosen ticket to In Progress.
    --json       Emit machine-readable JSON to stdout (single line).
    --verbose    Write the ranking table to stderr before the result.
    --help, -h   Show this usage text and exit.

  Examples
    $ pick-linear-ticket --team RAN --workspace emberengineering --json
    $ pick-linear-ticket RAN-22 --team RAN --workspace emberengineering --start

  Exit codes
    0  Picked successfully.
    2  No eligible candidate.
    3  Explicit pick failed gates (wrong team, terminal state, active blocker).
    4  Workspace mismatch after OAuth retry — re-run \`linear-cli auth oauth\`.
    5  linear-cli missing, Linear CLI error, or unknown error.
    6  Timed out — a subprocess or filesystem op wedged (watchdog).
`,
  {
    importMeta: import.meta,
    flags: {
      team: { type: 'string' },
      workspace: { type: 'string' },
      start: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', shortFlag: 'h', default: false },
    },
  },
)

/**
 * Meow's auto-help only triggers when `--help` is the only argument
 * (see meow's `argv._.length === 0 && options.argv.length === 1` guard).
 * Wrappers like `pnpm pick-linear-ticket --help` always pass extra args, so handle
 * `--help` explicitly here and validate `--team`/`--workspace` ourselves.
 */
if (cli.flags.help) {
  cli.showHelp(0)
}
if (!cli.flags.team || !cli.flags.workspace) {
  consola.error('Both --team and --workspace are required.')
  cli.showHelp(1)
  process.exit(1)
}
const teamKey: string = cli.flags.team
const workspace: string = cli.flags.workspace

const log = consola.withTag('pick-linear-ticket')

/**
 * Directory holding one sub-directory per claimed ticket. Defaults to the home
 * directory (not the repo) so a single set of claims is shared across every
 * worktree/clone the picker runs from. `PICK_LINEAR_LOCK_DIR` overrides it —
 * handy for scoping claims per-project or pointing at a writable path in
 * sandboxed environments.
 */
const lockDir = process.env.PICK_LINEAR_LOCK_DIR ?? join(homedir(), '.pick-linear-ticket-locks')

/**
 * How long a claim survives before {@link cleanupStaleLocks} reclaims it. Long
 * enough to bridge a burst of concurrent invocations fanning out to distinct
 * tickets; short enough that a crashed picker frees its ticket quickly. A
 * successful `--start` moves the ticket out of eligibility well before this, so
 * the timeout only ever matters for crash recovery.
 */
const STALE_LOCK_SECONDS = 30

/** Single-line human-readable result for stdout. */
function formatHuman(
  id: Identifier,
  branchName: string,
  url: string,
  reason: string,
  started: boolean,
): string {
  return `${id}  ${branchName}  ${url}  (${reason})${started ? '  [started]' : ''}\n`
}

/** Single-line JSON result for stdout. */
function formatJson(
  id: Identifier,
  title: string,
  url: string,
  branchName: string,
  reason: string,
  started: boolean,
): string {
  return JSON.stringify({ id, title, url, branchName, reason, started }) + '\n'
}

/** Writes the ranking table for the surviving candidates to stderr. */
function writeVerboseTable(candidates: Candidate[]): void {
  const header = [
    'id'.padEnd(10),
    'inCycle'.padEnd(10),
    'state'.padEnd(10),
    'unblocks'.padEnd(10),
    'priority'.padEnd(10),
    'blockedBy'.padEnd(20),
    'createdAt',
  ].join('')
  process.stderr.write(`${header}\n`)
  for (const c of candidates) {
    const row = [
      c.identifier.padEnd(10),
      String(c.inCycle).padEnd(10),
      c.stateName.padEnd(10),
      String(c.unblocks).padEnd(10),
      (PRIORITY_LABELS[c.priority] ?? String(c.priority)).padEnd(10),
      `[${c.blockedBy.join(',')}]`.padEnd(20),
      c.createdAt,
    ].join('')
    process.stderr.write(`${row}\n`)
  }
}

async function runAutoSelect(
  config: LinearConfig,
  args: {
    start: boolean
    json: boolean
    verbose: boolean
  },
): Promise<void> {
  const currentUserName = await whoami()

  const [cycleIds, relations, allIssues] = await Promise.all([
    activeCycleIdentifiers(config, currentUserName),
    activeSetRelations(config),
    listAllIssues(config),
  ])

  const activeStateNames = new Set(['Backlog', 'Todo', 'In Progress'])
  const activeIdentifiers = new Set<Identifier>(
    allIssues.filter((i) => activeStateNames.has(i.stateName)).map((i) => i.identifier),
  )

  const unblocks = new Map<Identifier, Identifier[]>()
  const blockedBy = new Map<Identifier, Identifier[]>()
  for (const rel of relations) {
    const activeDownstream = rel.blocks.filter((b) => activeIdentifiers.has(b))
    unblocks.set(rel.identifier, activeDownstream)
    for (const downstream of activeDownstream) {
      const existing = blockedBy.get(downstream) ?? []
      existing.push(rel.identifier)
      blockedBy.set(downstream, existing)
    }
  }

  /**
   * Eligibility: in the active cycle, OR explicitly marked `Todo`. Plain
   * `Backlog` is intentionally excluded — Backlog is a parking lot for
   * "we might do this someday," and the user signals "actually pick this
   * up" by either pulling the ticket into the active cycle or moving it
   * to `Todo`. Without the filter, the picker happily returns Backlog
   * tickets that the user has been declining for weeks.
   */
  const eligibleIssues = allIssues.filter(
    (i) =>
      (cycleIds.has(i.identifier) || i.stateName === 'Todo') &&
      (i.assigneeName === null || i.assigneeName === currentUserName),
  )

  const candidateIds = eligibleIssues.map((i) => i.identifier)
  const createdAtMap = candidateIds.length > 0 ? await createdAtFor(config, candidateIds) : {}

  const candidatePool = new Map<Identifier, Candidate>()
  for (const issue of eligibleIssues) {
    candidatePool.set(issue.identifier, {
      ...issue,
      inCycle: cycleIds.has(issue.identifier),
      /**
       * Missing `createdAt` sorts LAST in the oldest-wins tiebreak, not
       * first. Using the Unix epoch as a fallback would cause a candidate
       * without a known timestamp to silently beat real, older tickets.
       */
      createdAt: createdAtMap[issue.identifier] ?? MISSING_CREATED_AT,
      unblocks: (unblocks.get(issue.identifier) ?? []).length,
      blockedBy: blockedBy.get(issue.identifier) ?? [],
    })
  }

  const ranked = rankCandidates(candidatePool, activeIdentifiers)
  if (ranked.length === 0) {
    log.error('active cycle empty; no Todo candidates after blocking/assignment filters')
    process.exit(2)
  }

  if (args.verbose) {
    writeVerboseTable(ranked)
  }

  if (process.env.PICK_LINEAR_DEBUG) {
    process.stderr.write(
      `[lock pid=${process.pid}] dir=${lockDir} ranked=[${ranked.map((c) => c.identifier).join(', ')}]\n`,
    )
  }

  /**
   * Claim the highest-ranked ticket whose lock is free. When sibling processes
   * run at the same time, each grabs the next-best free ticket, so concurrent
   * invocations fan out to distinct tickets rather than colliding on the best
   * one. The claim persists after we exit; it's reclaimed by the staleness
   * sweep (or by `--start` moving the ticket out of eligibility).
   */
  const claim = await claimFirstAvailable(ranked, lockDir)
  if (claim === null) {
    log.error('Every eligible ticket is already claimed by a concurrent pick. Try again shortly.')
    process.exit(2)
  }
  const { chosen, lockedAhead } = claim

  /**
   * Explain the pick. When nothing higher-ranked was claimed, reuse the normal
   * runner-up comparison. Otherwise the honest reason is that the better
   * tickets were taken by concurrent picks.
   */
  let reason: string
  if (lockedAhead === 0) {
    const runnerUp = ranked[1]
    reason =
      runnerUp === undefined ? 'only eligible candidate' : buildReason(chosen, runnerUp, unblocks)
  } else {
    const plural = lockedAhead === 1 ? 'ticket' : 'tickets'
    reason = `next available (${lockedAhead} higher-ranked ${plural} claimed by concurrent picks)`
  }

  const branchName = buildBranchName(chosen.identifier, chosen.title)

  let started = false
  if (args.start) {
    try {
      await startIssue(chosen.identifier)
      started = true
    } catch (error) {
      /** Starting failed — free the claim so another picker can take it. */
      await releaseLock(chosen.identifier, lockDir)
      log.error((error as Error).message)
      process.exit(5)
    }
  }

  const out = args.json
    ? formatJson(chosen.identifier, chosen.title, chosen.url, branchName, reason, started)
    : formatHuman(chosen.identifier, branchName, chosen.url, reason, started)
  process.stdout.write(out)

  if (process.env.PICK_LINEAR_DEBUG) {
    const { readdirSync } = await import('node:fs')
    let contents: string
    try {
      contents = readdirSync(lockDir).join(', ')
    } catch (error) {
      contents = `<readdir failed: ${(error as Error).message}>`
    }
    process.stderr.write(
      `[lock pid=${process.pid}] end-of-run: ${lockDir} contains [${contents}]\n`,
    )
  }
}

async function runExplicitPick(
  rawId: string,
  config: LinearConfig,
  args: { start: boolean; json: boolean },
): Promise<void> {
  const id = rawId.toUpperCase()
  if (!isIdentifier(id)) {
    log.error(`Invalid ticket id: ${rawId}`)
    process.exit(3)
  }

  let issue: Awaited<ReturnType<typeof getIssue>>
  try {
    issue = await getIssue(id, config)
  } catch (error) {
    log.error((error as Error).message)
    process.exit(5)
  }

  if (issue.teamName !== config.teamName) {
    log.error(`${id} belongs to team ${issue.teamName}, not ${config.teamName}`)
    process.exit(3)
  }

  if (issue.stateName === 'Done' || issue.stateName === 'Canceled') {
    log.error(`${id} is ${issue.stateName}`)
    process.exit(3)
  }

  const activeBlockerStates = new Set(['Backlog', 'Todo', 'In Progress'])
  const activeBlockers = issue.blockers.filter((b) => activeBlockerStates.has(b.stateName))
  if (activeBlockers.length > 0) {
    const list = activeBlockers.map((b) => `${b.identifier} [${b.stateName}]`).join(', ')
    log.error(`${id} is blocked by: ${list}`)
    process.exit(3)
  }

  const branchName = buildBranchName(id, issue.title)

  let started = false
  if (args.start) {
    try {
      await startIssue(id)
      started = true
    } catch (error) {
      log.error((error as Error).message)
      process.exit(5)
    }
  }

  const reason = 'explicit pick'
  const out = args.json
    ? formatJson(id, issue.title, issue.url, branchName, reason, started)
    : formatHuman(id, branchName, issue.url, reason, started)
  process.stdout.write(out)
}

async function main(): Promise<void> {
  /** Reclaim any locks left behind by a crashed picker before claiming our own. */
  await cleanupStaleLocks(lockDir, STALE_LOCK_SECONDS)

  const config = await preflight({ teamKey, workspace })

  const ticketId = cli.input[0]
  const common = {
    start: cli.flags.start,
    json: cli.flags.json,
  }

  if (ticketId !== undefined) {
    await runExplicitPick(ticketId, config, common)
  } else {
    await runAutoSelect(config, { ...common, verbose: cli.flags.verbose })
  }
}

/**
 * Hard upper bound on a single run. A pick should take a couple of seconds;
 * anything longer means a wedged subprocess or a stalled filesystem operation.
 * The watchdog turns that into a fast, loud failure (exit 6) instead of a
 * process that hangs forever at 100% CPU — exactly what happened when a
 * detached, orphaned picker was left parked on an unresolved async request.
 * Overridable via `PICK_LINEAR_TIMEOUT_MS` for slow links or tests.
 */
const WATCHDOG_MS = Number(process.env.PICK_LINEAR_TIMEOUT_MS) || 60_000

try {
  await withTimeout(main(), WATCHDOG_MS, 'pick-linear-ticket')
} catch (error) {
  if (error instanceof TimeoutError) {
    log.error(error.message)
    process.exit(6)
  }
  if (error instanceof LinearCliMissingError) {
    log.error('linear-cli is not installed on this machine.')
    log.info(`Install instructions: ${LINEAR_CLI_INSTALL_URL}`)
    process.exit(5)
  }
  if (error instanceof WorkspaceMismatchError) {
    log.error(error.message)
    log.warn("Hint: run 'linear-cli auth oauth' and pick the right workspace.")
    process.exit(4)
  }
  log.error((error as Error).message)
  process.exit(5)
}

/**
 * The pick succeeded and its output is written. `main()` resolving does not
 * guarantee the event loop is empty — a dependency that leaves a handle (or, as
 * we saw in the wild, an fs request that never fires its callback) would keep
 * Node alive indefinitely. Force the exit, but on an `unref`'d grace timer so a
 * run that drains on its own is never delayed and a piped stdout write is never
 * truncated by an immediate `process.exit`.
 */
const forceExit = setTimeout(() => process.exit(0), 1000)
forceExit.unref()
