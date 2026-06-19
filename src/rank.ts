import type { Candidate, CandidatePool, Identifier, PickResult } from './types.ts'

/**
 * Maps numeric Linear priority to a human-readable label. Exported so the CLI
 * `--verbose` table can reuse it; keeping it in one place prevents the labels
 * from drifting between the reason string and the table.
 */
export const PRIORITY_LABELS: Readonly<Record<number, string>> = {
  0: 'None',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
}

/**
 * Returns the sort key for a priority value. Priority `0` (No priority) sorts
 * last, so it maps to `Infinity`.
 */
function prioritySortKey(priority: number): number {
  return priority === 0 ? Infinity : priority
}

/**
 * A candidate is "promoted" when it has been signalled as wanted soon —
 * either by being added to the active cycle or by the user moving it from
 * `Backlog` to `Todo`. Promoted candidates sort above plain backlog work.
 */
export function isPromoted(c: Candidate): boolean {
  return c.inCycle || c.stateName === 'Todo'
}

/**
 * Comparator for sorting candidates in descending preference order:
 * 1. Promoted (in-cycle OR `Todo`) ahead of plain `Backlog`.
 * 2. `unblocks` descending (more unblocks is better).
 * 3. Priority ascending, with `0` (No priority) treated as `Infinity`.
 * 4. `createdAt` ascending (older is better).
 *
 * Exported so the CLI's `--verbose` ranking table can sort with the same
 * key the picker uses, without duplicating the comparator.
 */
export function compareCandidates(a: Candidate, b: Candidate): number {
  const aPromoted = isPromoted(a)
  const bPromoted = isPromoted(b)
  if (aPromoted !== bPromoted) {
    return aPromoted ? -1 : 1
  }

  if (a.unblocks !== b.unblocks) {
    return b.unblocks - a.unblocks
  }

  /**
   * Avoid `Infinity - Infinity` (which is `NaN`) when both candidates are
   * priority 0. A `NaN` return from the comparator skips this dimension AND
   * the `createdAt` fallback, leaving V8's stable-sort to silently decide
   * by insertion order. Compare the keys with `<` / `>` instead.
   */
  const aPriority = prioritySortKey(a.priority)
  const bPriority = prioritySortKey(b.priority)
  if (aPriority < bPriority) return -1
  if (aPriority > bPriority) return 1

  if (a.createdAt < b.createdAt) return -1
  if (a.createdAt > b.createdAt) return 1
  return 0
}

/**
 * Returns the eligible candidates in descending preference order. Candidates
 * blocked by any identifier in `activeIdentifiers` are dropped before sorting.
 *
 * Shared by {@link pickCandidate} (which takes the head) and the CLI's
 * lock-walk, which iterates the whole list claiming the first ticket whose
 * lock is free — so concurrent invocations fan out to distinct tickets instead
 * of colliding on the single best one.
 */
export function rankCandidates(
  pool: CandidatePool,
  activeIdentifiers: ReadonlySet<Identifier>,
): Candidate[] {
  const survivors = [...pool.values()].filter(
    (c) => !c.blockedBy.some((b) => activeIdentifiers.has(b)),
  )
  survivors.sort(compareCandidates)
  return survivors
}

/**
 * Builds a short human-readable reason that explains why `chosen` was preferred
 * over `runnerUp`. Returns the label for the first dimension where the two
 * candidates strictly differ.
 */
export function buildReason(
  chosen: Candidate,
  runnerUp: Candidate,
  unblocksMap: ReadonlyMap<Identifier, Identifier[]>,
): string {
  if (isPromoted(chosen) && !isPromoted(runnerUp)) {
    if (chosen.inCycle) return 'in active cycle'
    return 'marked as Todo'
  }

  if (chosen.unblocks > runnerUp.unblocks) {
    const downstream = unblocksMap.get(chosen.identifier) ?? []
    /**
     * The caller's `unblocksMap` is supposed to track the same edges that
     * fed `chosen.unblocks`, but the function's interface allows them to
     * diverge (e.g. tests that pass an empty map). Fall back to a generic
     * phrasing so the reason stays well-formed in that case.
     */
    return downstream.length > 0 ? `blocks ${downstream.join(', ')}` : 'unblocks more issues'
  }

  const chosenKey = prioritySortKey(chosen.priority)
  const runnerUpKey = prioritySortKey(runnerUp.priority)
  if (chosenKey < runnerUpKey) {
    const name = PRIORITY_LABELS[chosen.priority] ?? `priority ${chosen.priority}`
    return `highest priority (${name})`
  }

  if (chosen.createdAt < runnerUp.createdAt) {
    return 'oldest by createdAt'
  }

  /**
   * All four dimensions tied. Reachable when multiple candidates share the
   * same promotion state, unblocks count, priority, and createdAt (e.g. both
   * fall back to `MISSING_CREATED_AT`). The chosen one wins by insertion
   * order from the stable sort.
   */
  return 'tied on all ranking dimensions'
}

/**
 * Selects the best candidate from `pool` using a four-dimension ranking:
 * promoted (in-cycle OR `Todo`) > unblocks > priority > createdAt.
 *
 * Candidates blocked by any identifier in `activeIdentifiers` are dropped
 * before ranking. `unblocksMap` supplies the downstream identifier lists needed
 * to compose a meaningful reason string when the unblocks count breaks a tie.
 */
export function pickCandidate(
  pool: CandidatePool,
  activeIdentifiers: ReadonlySet<Identifier>,
  unblocksMap: ReadonlyMap<Identifier, Identifier[]>,
): PickResult {
  const survivors = rankCandidates(pool, activeIdentifiers)

  if (survivors.length === 0) {
    return {
      kind: 'no-candidates',
      why: 'active cycle empty; no Todo candidates after blocking/assignment filters',
    }
  }

  /** survivors is non-empty at this point (checked above). */
  const chosen = survivors[0] as Candidate
  const runnerUp: Candidate | undefined = survivors[1]

  const reason =
    runnerUp === undefined ? 'only eligible candidate' : buildReason(chosen, runnerUp, unblocksMap)

  return {
    kind: 'chosen',
    issue: chosen,
    reason,
  }
}
