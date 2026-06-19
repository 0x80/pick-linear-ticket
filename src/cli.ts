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
import { acquireLock, cleanupStaleLocks, releaseLock } from './lock.ts'
import { PRIORITY_LABELS, compareCandidates, pickCandidate } from './rank.ts'
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
const lockDir = join(homedir(), '.pick-linear-ticket-locks')
let currentLockId: Identifier | null = null

/**
 * Best-effort cleanup on exit. Since locks are cleaned up after 30 seconds
 * anyway, if this fails it's not critical — the next run will clean it up.
 */
async function cleanup(): Promise<void> {
  if (currentLockId !== null) {
    await releaseLock(currentLockId, lockDir)
  }
}

process.on('beforeExit', () => {
  cleanup().catch(() => {
    // Ignore cleanup errors
  })
})

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

  const pickResult = pickCandidate(candidatePool, activeIdentifiers, unblocks)
  if (pickResult.kind === 'no-candidates') {
    log.error(pickResult.why)
    process.exit(2)
  }

  const chosen = pickResult.issue

  /** Try to acquire lock. If another process is picking this ticket, bail. */
  log.debug(`[lock] Attempting to lock ${chosen.identifier}`)
  let lockAcquired = false
  try {
    lockAcquired = await acquireLock(chosen.identifier, lockDir)
  } catch (error) {
    log.error(`Lock acquisition failed: ${(error as Error).message}`)
    process.exit(5)
  }

  if (!lockAcquired) {
    log.error(`${chosen.identifier} is being picked by another process. Try again in a moment.`)
    log.debug(`[lock] Failed to acquire lock for ${chosen.identifier}`)
    process.exit(2)
  }
  log.debug(`[lock] Successfully locked ${chosen.identifier}`)
  currentLockId = chosen.identifier

  const branchName = buildBranchName(chosen.identifier, chosen.title)

  let started = false
  if (args.start) {
    try {
      await startIssue(chosen.identifier)
      started = true
    } catch (error) {
      log.error((error as Error).message)
      process.exit(5)
    }
  }

  if (args.verbose) {
    const survivors = [...candidatePool.values()].filter(
      (c) => !c.blockedBy.some((b) => activeIdentifiers.has(b)),
    )
    survivors.sort(compareCandidates)
    writeVerboseTable(survivors)
  }

  const out = args.json
    ? formatJson(
        chosen.identifier,
        chosen.title,
        chosen.url,
        branchName,
        pickResult.reason,
        started,
      )
    : formatHuman(chosen.identifier, branchName, chosen.url, pickResult.reason, started)
  process.stdout.write(out)
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
  /** Clean up locks older than 30 seconds. */
  log.debug(`[lock] Cleaning up stale locks in ${lockDir}`)
  await cleanupStaleLocks(lockDir, 30)

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

try {
  await main()
} catch (error) {
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
