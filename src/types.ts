/**
 * Far-future ISO-8601 timestamp used when a candidate's `createdAt` is
 * unknown. Picks LAST in the oldest-wins tiebreak — i.e. real timestamps
 * always win over missing data. Used by the auto-select path and the
 * explicit-pick `getIssue` fallback.
 */
export const MISSING_CREATED_AT = '9999-12-31T23:59:59.999Z'

/** A branded string for Linear issue identifiers matching the pattern `<KEY>-<N>`. */
export type Identifier = string & { readonly __brand: 'Identifier' }

/**
 * Returns true iff `value` matches the shape `<KEY>-<N>` where `<KEY>` is one
 * or more uppercase ASCII letters/digits/underscores and `<N>` is one or more
 * digits. We don't constrain to a specific team here so the CLI works across
 * teams via `--team`; the actual team match happens in the data-flow against
 * the resolved `LinearConfig.teamName`.
 */
export function isIdentifier(value: string): value is Identifier {
  return /^[A-Z][A-Z0-9_]*-\d+$/.test(value)
}

/**
 * Linear priority levels as they appear on the wire.
 * - `0` = No priority
 * - `1` = Urgent
 * - `2` = High
 * - `3` = Medium
 * - `4` = Low
 */
export type Priority = 0 | 1 | 2 | 3 | 4

/** Core fields present on every Linear issue we interact with. */
export type IssueCore = {
  identifier: Identifier
  title: string
  priority: Priority
  stateName: string
  /** `null` when the issue is unassigned — matches Linear's JSON representation. */
  assigneeName: string | null
  url: string
}

/** An issue that has passed the initial filter and is eligible for ranking. */
export type Candidate = IssueCore & {
  /** Whether this issue is part of the currently active cycle. */
  inCycle: boolean
  /** ISO-8601 creation timestamp. */
  createdAt: string
  /** Number of still-active issues this issue blocks. */
  unblocks: number
  /** Identifiers of still-active issues that block this one. */
  blockedBy: Identifier[]
}

/**
 * The full set of eligible candidates, keyed by identifier.
 * Using a map (rather than an array) lets `pickCandidate` look up blockers by
 * id in O(1) without a secondary index.
 */
export type CandidatePool = ReadonlyMap<Identifier, Candidate>

/**
 * The outcome of a pick attempt.
 *
 * Narrow via `result.kind`:
 * - `'chosen'` — a candidate was selected; `issue` and `reason` are populated.
 *   The branch name + start transition are the caller's concern (see
 *   `cli.ts`); keeping them out of this type leaves `pickCandidate` purely
 *   about ranking.
 * - `'no-candidates'` — no eligible issues remain; `why` describes the gap
 *   (e.g. "active cycle empty; backlog empty after blocking/assignment filters").
 */
export type PickResult =
  | {
      kind: 'chosen'
      issue: Candidate
      reason: string
    }
  | {
      kind: 'no-candidates'
      why: string
    }
