import type { Candidate, CandidatePool, Identifier } from './types.ts'

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
 * Comparator for sorting candidates in descending preference order:
 * 1. `unblocks` descending (more unblocks is better).
 * 2. Priority ascending, with `0` (No priority) treated as `Infinity`.
 * 3. `createdAt` ascending (older is better).
 *
 * There is deliberately no "promoted" tier above these. One used to sit here,
 * ranking in-cycle / `Todo` candidates above plain `Backlog` — but eligibility
 * upstream already admits only `inCycle || stateName === 'Todo'` (the exact
 * predicate the tier tested), so every candidate reaching this comparator
 * satisfied it and the tier could never discriminate. Restoring it only makes
 * sense together with a looser eligibility filter.
 *
 * Exported so the CLI's `--verbose` ranking table can sort with the same
 * key the picker uses, without duplicating the comparator.
 */
export function compareCandidates(a: Candidate, b: Candidate): number {
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
 * The CLI walks the whole returned list rather than just taking the head,
 * claiming the first ticket whose lock is free — so concurrent invocations fan
 * out to distinct tickets instead of colliding on the single best one. That
 * lock-walk is why this returns the ranked list instead of one winner.
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
   * All three dimensions tied. Reachable when multiple candidates share the
   * same unblocks count, priority, and createdAt (e.g. both fall back to
   * `MISSING_CREATED_AT`). The chosen one wins by insertion order from the
   * stable sort.
   */
  return 'tied on all ranking dimensions'
}
