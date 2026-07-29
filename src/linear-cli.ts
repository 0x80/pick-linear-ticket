import { ExecaError, execa } from 'execa'
import {
  type Identifier,
  type IssueCore,
  MISSING_CREATED_AT,
  type Priority,
  isIdentifier,
} from './types.ts'

/**
 * Resolved configuration for a single pick-linear-ticket run. The `teamId` is looked
 * up at startup from `teamKey` (which is what users actually know) so the rest
 * of the wrappers can use the ID directly in GraphQL queries.
 */
export type LinearConfig = {
  /** Linear team key, e.g. `RAN`. */
  teamKey: string
  /** Linear team display name, e.g. `Randezvous`. Resolved from the key. */
  teamName: string
  /** Linear team UUID, resolved from the key. */
  teamId: string
  /** Linear workspace URL slug, e.g. `emberengineering`. */
  workspace: string
}

/** Thrown when `linear-cli` is authenticated to the wrong Linear workspace. */
export class WorkspaceMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceMismatchError'
  }
}

/** Thrown when the `linear-cli` binary is not on `$PATH`. */
export class LinearCliMissingError extends Error {
  constructor() {
    super('linear-cli binary not found on $PATH')
    this.name = 'LinearCliMissingError'
  }
}

/** Install instructions URL for `linear-cli`, shown when the binary is missing. */
export const LINEAR_CLI_INSTALL_URL = 'https://github.com/Finesssee/linear-cli'

/**
 * Per-subprocess deadline. A single non-interactive `linear-cli` call is one
 * GraphQL round-trip; if it hasn't answered in this long it has wedged, so
 * `execa` kills the child and rejects rather than letting it block the picker.
 * Kept below the CLI's overall watchdog so this more specific error surfaces
 * first. The interactive OAuth flow is deliberately exempt — it legitimately
 * waits on the user and the browser handshake.
 */
const SUBPROCESS_TIMEOUT_MS = 30_000

async function runLinear(args: string[]): Promise<string> {
  try {
    const { stdout } = await execa('linear-cli', args, { timeout: SUBPROCESS_TIMEOUT_MS })
    return stdout
  } catch (error) {
    const stderr = error instanceof ExecaError ? error.stderr : ''
    throw new Error(`linear-cli ${args.join(' ')} failed:\n${stderr}`, { cause: error })
  }
}

/**
 * Detects whether `linear-cli` is installed by attempting `--version`. Any
 * `ENOENT` from spawn indicates the binary is missing from `$PATH`; other
 * failures (e.g. the binary exists but errored) count as "installed" so the
 * actual error surfaces from the real call path rather than here.
 */
async function isLinearCliInstalled(): Promise<boolean> {
  try {
    await execa('linear-cli', ['--version'], { timeout: SUBPROCESS_TIMEOUT_MS })
    return true
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return false
    }
    return true
  }
}

/**
 * Asks `linear-cli` whether it currently holds credentials. Returns `true`
 * when `auth status` reports `configured: true`; treats any failure as "not
 * authenticated" so the OAuth flow runs and gives the user a clean path
 * forward instead of dumping a CLI error.
 */
async function isLinearCliAuthenticated(): Promise<boolean> {
  try {
    const { stdout } = await execa('linear-cli', ['auth', 'status', '-o', 'json'], {
      timeout: SUBPROCESS_TIMEOUT_MS,
    })
    const data = JSON.parse(stdout) as { configured?: boolean }
    return data.configured === true
  } catch {
    return false
  }
}

/**
 * Runs `linear-cli auth oauth` with inherited stdio so the user sees the CLI's
 * prompts, the browser opens for the OAuth handshake, and any TTY-driven
 * workspace picker stays interactive. Throws if the user cancels or the flow
 * fails — the caller should treat that as a fatal preflight error.
 */
async function runOauthFlow(): Promise<void> {
  await execa('linear-cli', ['auth', 'oauth'], { stdio: 'inherit' })
}

/**
 * Preflight verification before any command that talks to Linear:
 *
 * 1. `linear-cli` is installed — otherwise throws `LinearCliMissingError`
 *    and the CLI shell points the user at the install instructions.
 * 2. `linear-cli` is authenticated — if not, kicks off `auth oauth`
 *    interactively so the browser-based handshake can complete.
 * 3. The authenticated workspace contains the requested team — if not,
 *    re-runs `auth oauth` so the user can re-select the right workspace,
 *    then retries the team lookup once.
 *
 * Returns the resolved `LinearConfig` so callers don't need to invoke
 * `ensureWorkspace` again.
 */
export async function preflight(args: {
  teamKey: string
  workspace: string
}): Promise<LinearConfig> {
  if (!(await isLinearCliInstalled())) {
    throw new LinearCliMissingError()
  }

  if (!(await isLinearCliAuthenticated())) {
    process.stderr.write('linear-cli is not authenticated. Launching OAuth flow…\n')
    await runOauthFlow()
  }

  try {
    return await ensureWorkspace(args)
  } catch (error) {
    if (!(error instanceof WorkspaceMismatchError)) throw error
    process.stderr.write(
      `${error.message}\nLaunching OAuth flow to authenticate for the right workspace…\n`,
    )
    await runOauthFlow()
    return ensureWorkspace(args)
  }
}

function parseJson(stdout: string, context: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch (error) {
    throw new Error(`Failed to parse JSON from ${context}: ${String(error)}`, { cause: error })
  }
}

/**
 * Verifies that `linear-cli` is authenticated to a workspace that contains the
 * requested team and resolves the team's UUID. Clears the cache and retries
 * once if the team is missing on the first attempt. Throws
 * `WorkspaceMismatchError` if the team is still absent after the retry.
 */
export async function ensureWorkspace(args: {
  teamKey: string
  workspace: string
}): Promise<LinearConfig> {
  async function fetchTeams(): Promise<{ id: string; key: string; name: string }[]> {
    const stdout = await runLinear(['teams', 'list', '-o', 'json', '--no-cache'])
    return parseJson(stdout, 'teams list') as { id: string; key: string; name: string }[]
  }

  let teams = await fetchTeams()
  let found = teams.find((t) => t.key === args.teamKey)
  if (!found) {
    await runLinear(['cache', 'clear'])
    teams = await fetchTeams()
    found = teams.find((t) => t.key === args.teamKey)
  }
  if (!found) {
    throw new WorkspaceMismatchError(
      `linear-cli does not see team ${args.teamKey}; run \`linear-cli auth oauth\` and choose the right workspace`,
    )
  }
  return {
    teamKey: found.key,
    teamName: found.name,
    teamId: found.id,
    workspace: args.workspace,
  }
}

/** Returns the current authenticated user's display name, or `null` on failure. */
export async function whoami(): Promise<string | null> {
  try {
    const stdout = await runLinear(['whoami', '-o', 'json'])
    const data = parseJson(stdout, 'whoami') as { name?: string }
    return data.name ?? null
  } catch {
    return null
  }
}

/**
 * Returns the set of identifiers in the team's active cycle that are still
 * unstarted (Backlog/Todo) and assigned to either the current user or nobody.
 */
export async function activeCycleIdentifiers(
  config: LinearConfig,
  currentUserName: string | null,
): Promise<Set<Identifier>> {
  const stdout = await runLinear(['sprint', 'status', '-t', config.teamName, '-o', 'json'])
  const data = parseJson(stdout, 'sprint status') as {
    issues?: {
      nodes?: {
        identifier: string
        state?: { type?: string }
        assignee?: { name?: string } | null
      }[]
    }
  }
  /**
   * Linear's `state.type` is one of `triage`, `backlog`, `unstarted`, `started`,
   * `completed`, `canceled`. The user-facing `Backlog` state maps to `backlog`
   * and `Todo` maps to `unstarted`; the candidate pool downstream accepts both,
   * so the cycle pass must too.
   */
  const eligibleStateTypes = new Set(['backlog', 'unstarted'])
  const result = new Set<Identifier>()
  for (const node of data.issues?.nodes ?? []) {
    if (!eligibleStateTypes.has(node.state?.type ?? '')) continue
    const assignee = node.assignee?.name ?? null
    const eligible = assignee === null || assignee === currentUserName
    if (!eligible) continue
    if (isIdentifier(node.identifier)) result.add(node.identifier)
  }
  return result
}

/**
 * Linear `state.type` values that count as active work. The candidate pool,
 * the blocker-active check, and the relations graph all operate on these
 * three; `completed` (Done), `canceled`, and `triage` are intentionally
 * excluded. Every team-issue query filters on these so a team's completed
 * history can't crowd still-open tickets out of a capped (`first: N`) fetch
 * window — the cause of older `Todo` tickets silently dropping out of the
 * candidate set once Done issues fill the page.
 */
const ACTIVE_STATE_TYPES = ['unstarted', 'backlog', 'started'] as const

/** GraphQL `IssueFilter` fragment restricting a query to {@link ACTIVE_STATE_TYPES}. */
const ACTIVE_STATE_FILTER = `filter: { state: { type: { in: ${JSON.stringify([...ACTIVE_STATE_TYPES])} } } }`

/**
 * Page size for the flat (scalar-only) team-issue query. These select only
 * scalar fields, so a large window costs little complexity. Pagination means
 * this is a round-trip/complexity tuning knob, not a correctness bound.
 */
const ACTIVE_ISSUE_PAGE_SIZE = 250

/**
 * Page size for the relations query. Bounded by Linear's 10000-complexity
 * ceiling: the `relations.nodes.relatedIssue` triple-nested selection costs
 * roughly 112 complexity per issue, so `first: 100` is rejected outright
 * ("Complexity: 11231. Maximum allowed complexity: 10000") while 75 still
 * passes. Complexity is computed statically from the `first:` multipliers, not
 * from how many relations the issues actually have, so the ceiling is stable.
 * 50 keeps comfortable headroom; correctness no longer depends on the value
 * because {@link collectIssuePages} walks every page.
 */
const RELATIONS_PAGE_SIZE = 50

/**
 * Hard bound on how many pages a single connection walk will fetch. At the
 * smallest page size in use ({@link RELATIONS_PAGE_SIZE}) this covers 1000
 * active issues, far beyond any real team, so hitting it means the cursor
 * stopped advancing rather than that the backlog is genuinely that large. It
 * exists to keep a pathological response from burning the CLI's watchdog
 * budget in a loop.
 */
const MAX_ISSUE_PAGES = 20

/** One page of a Linear connection, normalized for {@link collectIssuePages}. */
export type IssuePage<T> = {
  nodes: T[]
  hasNextPage: boolean
  /** `undefined` when the API returned no cursor to advance with. */
  endCursor: string | undefined
}

/**
 * Walks a cursor-paginated Linear connection to exhaustion and returns every
 * node. `fetchPage` receives the cursor to resume from (`undefined` for the
 * first page).
 *
 * This is what makes the relations graph complete. Previously the relations
 * query took a single `first: 50` window and warned that the graph "may be
 * partial" beyond that — which meant that on any team with more than 50 active
 * issues the ranking silently missed `blocks` edges, so a blocked ticket could
 * be picked and an unblocking ticket under-credited. The complexity ceiling
 * genuinely does forbid a larger window, but it says nothing about how many
 * windows we may ask for.
 *
 * Split from the query construction so the loop's termination and its
 * defensive guards are unit-testable without spawning `linear-cli`.
 */
export async function collectIssuePages<T>(
  fetchPage: (cursor: string | undefined) => Promise<IssuePage<T>>,
  context: string,
): Promise<T[]> {
  const all: T[] = []
  let cursor: string | undefined

  for (let page = 0; page < MAX_ISSUE_PAGES; page++) {
    const { nodes, hasNextPage, endCursor } = await fetchPage(cursor)
    all.push(...nodes)

    if (!hasNextPage) return all

    /**
     * `hasNextPage` without a cursor leaves nowhere to resume from. Returning
     * what we have beats looping on the same first page forever.
     */
    if (endCursor === undefined) {
      process.stderr.write(
        `pick-linear-ticket: ${context} reported more pages but returned no cursor; ` +
          `continuing with ${all.length} issues.\n`,
      )
      return all
    }
    cursor = endCursor
  }

  process.stderr.write(
    `pick-linear-ticket: ${context} stopped at the ${MAX_ISSUE_PAGES}-page guard ` +
      `(${all.length} issues); results may be incomplete.\n`,
  )
  return all
}

/**
 * Fetches every active issue in the team, paging until the connection is
 * exhausted, and returns the raw nodes for the given GraphQL `selection`.
 * Callers supply only the fields they need so each query's complexity stays
 * proportional to its own selection.
 */
async function fetchActiveIssues<T>(args: {
  config: LinearConfig
  selection: string
  pageSize: number
  context: string
}): Promise<T[]> {
  const fetchPage = async (cursor: string | undefined): Promise<IssuePage<T>> => {
    const after = cursor === undefined ? '' : `, after: ${JSON.stringify(cursor)}`
    const query = `
      query {
        team(id: "${args.config.teamId}") {
          issues(first: ${args.pageSize}${after}, ${ACTIVE_STATE_FILTER}) {
            pageInfo { hasNextPage endCursor }
            nodes { ${args.selection} }
          }
        }
      }
    `
    const stdout = await runLinear(['api', 'query', query, '-o', 'json'])
    const data = parseJson(stdout, args.context) as {
      data?: {
        team?: {
          issues?: {
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
            nodes?: T[]
          }
        }
      }
    }
    const issues = data.data?.team?.issues
    return {
      nodes: issues?.nodes ?? [],
      hasNextPage: issues?.pageInfo?.hasNextPage === true,
      endCursor: issues?.pageInfo?.endCursor ?? undefined,
    }
  }

  const nodes = await collectIssuePages<T>(fetchPage, args.context)
  return nodes
}

/**
 * Fetches outgoing `blocks` relations across every active issue in the team.
 * Returns one entry per active issue; `blocks` is the list of identifiers the
 * source issue blocks. Paged at {@link RELATIONS_PAGE_SIZE} to stay under the
 * API's complexity ceiling while still covering the whole active set.
 */
export async function activeSetRelations(
  config: LinearConfig,
): Promise<{ identifier: Identifier; blocks: Identifier[] }[]> {
  const nodes = await fetchActiveIssues<{
    identifier: string
    relations?: {
      nodes?: { type: string; relatedIssue?: { identifier?: string } }[]
    }
  }>({
    config,
    selection: 'identifier relations { nodes { type relatedIssue { identifier } } }',
    pageSize: RELATIONS_PAGE_SIZE,
    context: 'activeSetRelations',
  })

  const result: { identifier: Identifier; blocks: Identifier[] }[] = []
  for (const node of nodes) {
    if (!isIdentifier(node.identifier)) continue
    const blocks: Identifier[] = []
    for (const rel of node.relations?.nodes ?? []) {
      if (rel.type !== 'blocks') continue
      const target = rel.relatedIssue?.identifier
      if (target && isIdentifier(target)) blocks.push(target)
    }
    result.push({ identifier: node.identifier, blocks })
  }
  return result
}

function parseIssueCore(
  raw: {
    identifier?: string
    title?: string
    priority?: number
    state?: { name?: string }
    assignee?: { name?: string } | null
    url?: string
    createdAt?: string
  },
  workspace: string,
): IssueCore | null {
  const identifier = raw.identifier
  if (!identifier || !isIdentifier(identifier)) return null
  const url = raw.url ?? `https://linear.app/${workspace}/issue/${identifier}`
  return {
    identifier,
    title: raw.title ?? '',
    priority: (raw.priority ?? 0) as Priority satisfies Priority,
    stateName: raw.state?.name ?? '',
    assigneeName: raw.assignee?.name ?? null,
    url,
    /**
     * Missing `createdAt` sorts LAST in the oldest-wins tiebreak, not first.
     * Using the Unix epoch as a fallback would let an issue with no known
     * timestamp silently beat real, older tickets.
     */
    createdAt: raw.createdAt ?? MISSING_CREATED_AT,
  }
}

/**
 * Lists the team's active (non-Done/Canceled) issues, paging until the
 * connection is exhausted.
 *
 * The active-state filter is load-bearing: the original `issues list
 * --limit 250` had no state filter, so a team with hundreds of completed
 * tickets returned a window saturated by Done/Canceled issues and the
 * actually-eligible `Todo` tickets fell outside it — never reaching the
 * candidate pool. Done/Canceled issues never qualify as candidates or active
 * blockers anyway, so dropping them at the source is both a correctness fix
 * and cheaper.
 *
 * `createdAt` is selected here rather than by a second query over the same
 * connection: the ranking's oldest-wins tiebreak needs it for every candidate,
 * and it is a scalar, so folding it in costs one field instead of a full extra
 * paginated walk.
 */
export async function listAllIssues(config: LinearConfig): Promise<IssueCore[]> {
  const nodes = await fetchActiveIssues<Parameters<typeof parseIssueCore>[0]>({
    config,
    selection: 'identifier title priority state { name } assignee { name } url createdAt',
    pageSize: ACTIVE_ISSUE_PAGE_SIZE,
    context: 'listAllIssues',
  })

  const result: IssueCore[] = []
  for (const raw of nodes) {
    const issue = parseIssueCore(raw, config.workspace)
    if (issue) result.push(issue)
  }
  return result
}

/**
 * Fetches a single issue plus its inverse blocking relations. Used by the
 * explicit-pick path to gate-check the requested ticket.
 */
export async function getIssue(
  id: Identifier,
  config: LinearConfig,
): Promise<{
  identifier: Identifier
  title: string
  priority: Priority
  stateName: string
  assigneeName: string | null
  url: string
  createdAt: string
  teamName: string
  blockers: { identifier: Identifier; stateName: string }[]
}> {
  const [issueStdout, relStdout] = await Promise.all([
    runLinear(['issues', 'get', id, '-o', 'json']),
    runLinear(['relations', 'list', id, '-o', 'json']),
  ])
  const issue = parseJson(issueStdout, `issues get ${id}`) as {
    identifier?: string
    title?: string
    priority?: number
    state?: { name?: string }
    assignee?: { name?: string } | null
    url?: string
    createdAt?: string
    team?: { name?: string }
  }
  const relations = parseJson(relStdout, `relations list ${id}`) as {
    inverseRelations?: {
      type: string
      issue?: { identifier?: string; state?: { name?: string } }
    }[]
  }

  const identifier = issue.identifier
  if (!identifier || !isIdentifier(identifier)) {
    throw new Error(`Linear returned no identifier for ${id}`)
  }

  const blockers: { identifier: Identifier; stateName: string }[] = []
  for (const rel of relations.inverseRelations ?? []) {
    if (rel.type !== 'blocks') continue
    const blocker = rel.issue?.identifier
    if (blocker && isIdentifier(blocker)) {
      blockers.push({ identifier: blocker, stateName: rel.issue?.state?.name ?? '' })
    }
  }

  return {
    identifier,
    title: issue.title ?? '',
    priority: (issue.priority ?? 0) as Priority satisfies Priority,
    stateName: issue.state?.name ?? '',
    assigneeName: issue.assignee?.name ?? null,
    url: issue.url ?? `https://linear.app/${config.workspace}/issue/${identifier}`,
    createdAt: issue.createdAt ?? MISSING_CREATED_AT,
    teamName: issue.team?.name ?? '',
    blockers,
  }
}

/** Moves a ticket to the team's started state and assigns it to the caller. */
export async function startIssue(id: Identifier): Promise<void> {
  await runLinear(['issues', 'start', id])
}
