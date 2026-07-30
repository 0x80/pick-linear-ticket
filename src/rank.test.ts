/**
 * Unit tests for the ranking. Each case targets a distinct ranking rule or edge
 * condition: empty pool, sole candidate, blocker filtering, and the three
 * ranking dimensions (unblocks, priority, createdAt).
 *
 * They drive `rankCandidates` + `buildReason` through the `pick` helper below,
 * which is the same two-step the CLI performs — so what is asserted here is the
 * production path rather than a parallel one.
 */

import { describe, expect, it } from 'vitest'

import type { Candidate, CandidatePool, Identifier } from './types.ts'
import { buildReason, rankCandidates } from './rank.ts'

/** Casts a plain string to the branded `Identifier` type for use in test fixtures. */
function id(value: string): Identifier {
  return value as Identifier
}

/** Shape accepted by `makeCandidate`; all fields except `identifier` are optional. */
type CandidateOverrides = {
  identifier: string
  title?: string
  priority?: number
  stateName?: string
  assigneeName?: string | null
  url?: string
  inCycle?: boolean
  createdAt?: string
  unblocks?: number
  blockedBy?: Identifier[]
}

/**
 * Builds a minimal Candidate with neutral defaults for fields not under test.
 * `stateName` and `inCycle` no longer affect ranking (see the note above the
 * unblocks cases below), so their defaults are inert.
 */
function makeCandidate(overrides: CandidateOverrides): Candidate {
  return {
    identifier: id(overrides.identifier),
    title: overrides.title ?? 'Test issue',
    priority: (overrides.priority ?? 0) as Candidate['priority'],
    stateName: overrides.stateName ?? 'Backlog',
    assigneeName: overrides.assigneeName ?? null,
    url: overrides.url ?? `https://linear.app/test/${overrides.identifier}`,
    inCycle: overrides.inCycle ?? false,
    createdAt: overrides.createdAt ?? '2024-01-01T00:00:00.000Z',
    unblocks: overrides.unblocks ?? 0,
    blockedBy: overrides.blockedBy ?? [],
  }
}

/** Converts an array of candidates into a CandidatePool map. */
function makePool(candidates: Candidate[]): CandidatePool {
  return new Map(candidates.map((c) => [c.identifier, c]))
}

/**
 * Ranks the pool and explains the winner against the runner-up — the exact
 * two-step `runAutoSelect` performs, minus the lock-walk (which only changes
 * *which* ranked entry is claimed, never the order). Returns `undefined` when
 * nothing survives, standing in for the CLI's exit-2 path.
 */
function pick(
  pool: CandidatePool,
  activeIdentifiers: ReadonlySet<Identifier>,
  unblocksMap: ReadonlyMap<Identifier, Identifier[]>,
): { chosen: Candidate; reason: string } | undefined {
  const ranked = rankCandidates(pool, activeIdentifiers)
  const chosen = ranked[0]
  if (chosen === undefined) return undefined
  const runnerUp = ranked[1]
  return {
    chosen,
    reason:
      runnerUp === undefined
        ? 'only eligible candidate'
        : buildReason(chosen, runnerUp, unblocksMap),
  }
}

describe('ranking', () => {
  it('yields nothing when the pool is empty', () => {
    expect(pick(new Map(), new Set(), new Map())).toBeUndefined()
  })

  it('reports "only eligible candidate" for a single candidate', () => {
    const candidate = makeCandidate({ identifier: 'RAN-1' })
    const pool = makePool([candidate])

    const result = pick(pool, new Set(), new Map())

    expect(result?.chosen).toBe(candidate)
    expect(result?.reason).toBe('only eligible candidate')
  })

  it('drops a candidate blocked by an active issue', () => {
    /** RAN-2 is active, so RAN-1 (which is blocked by RAN-2) should be filtered. */
    const blocked = makeCandidate({ identifier: 'RAN-1', blockedBy: [id('RAN-2')] })
    const pool = makePool([blocked])
    const activeIdentifiers = new Set([id('RAN-2')])

    expect(pick(pool, activeIdentifiers, new Map())).toBeUndefined()
  })

  it('keeps a candidate whose blocker is no longer active', () => {
    /** RAN-3 is NOT in activeIdentifiers (already done/canceled), so RAN-1 survives. */
    const candidate = makeCandidate({ identifier: 'RAN-1', blockedBy: [id('RAN-3')] })
    const pool = makePool([candidate])
    const activeIdentifiers = new Set<Identifier>() // RAN-3 is not active

    expect(pick(pool, activeIdentifiers, new Map())?.chosen).toBe(candidate)
  })

  it('returns the full ranked list, not just the winner, for the CLI lock-walk', () => {
    /**
     * The CLI claims the first ticket whose lock is free, so it needs every
     * survivor in order — not just the head.
     */
    const first = makeCandidate({ identifier: 'RAN-1', unblocks: 2 })
    const second = makeCandidate({ identifier: 'RAN-2', unblocks: 1 })
    const third = makeCandidate({ identifier: 'RAN-3', unblocks: 0 })
    const blocked = makeCandidate({ identifier: 'RAN-4', unblocks: 9, blockedBy: [id('RAN-5')] })
    const pool = makePool([third, blocked, first, second])

    const ranked = rankCandidates(pool, new Set([id('RAN-5')]))

    expect(ranked.map((c) => c.identifier)).toEqual(['RAN-1', 'RAN-2', 'RAN-3'])
  })

  it('picks the candidate with more unblocks, and reason mentions a downstream id', () => {
    const candidateA = makeCandidate({ identifier: 'RAN-11', unblocks: 1 })
    const candidateB = makeCandidate({ identifier: 'RAN-12', unblocks: 0 })
    const pool = makePool([candidateA, candidateB])
    const unblocksMap = new Map([[id('RAN-11'), [id('RAN-99')]]])

    const result = pick(pool, new Set(), unblocksMap)

    expect(result?.chosen.identifier).toBe('RAN-11')
    expect(result?.reason).toContain('blocks RAN-99')
  })

  it('picks the highest-priority candidate when unblocks are equal', () => {
    /** Priority 1 = Urgent, 3 = Medium, 0 = No priority. Urgent wins. */
    const urgent = makeCandidate({ identifier: 'RAN-10', priority: 1, unblocks: 0 })
    const medium = makeCandidate({ identifier: 'RAN-20', priority: 3, unblocks: 0 })
    const noPriority = makeCandidate({ identifier: 'RAN-30', priority: 0, unblocks: 0 })
    const pool = makePool([urgent, medium, noPriority])

    const result = pick(pool, new Set(), new Map())

    expect(result?.chosen.identifier).toBe('RAN-10')
    expect(result?.reason).toContain('Urgent')
  })

  it('picks the oldest candidate when unblocks and priority are equal', () => {
    const older = makeCandidate({
      identifier: 'RAN-1',
      priority: 0,
      unblocks: 0,
      createdAt: '2024-01-01T00:00:00.000Z',
    })
    const newer = makeCandidate({
      identifier: 'RAN-2',
      priority: 0,
      unblocks: 0,
      createdAt: '2024-06-01T00:00:00.000Z',
    })
    /**
     * Insert `newer` first so a broken comparator (one returning `NaN` from
     * `Infinity - Infinity` on both priority-0 candidates) would silently
     * fall back to insertion order and pick `newer` — masking the bug.
     */
    const pool = makePool([newer, older])

    const result = pick(pool, new Set(), new Map())

    expect(result?.chosen.identifier).toBe('RAN-1')
    expect(result?.reason).toContain('oldest by createdAt')
  })

  /**
   * There is no "promoted" (in-cycle / `Todo` above plain `Backlog`) tier to
   * test: eligibility upstream admits only `inCycle || stateName === 'Todo'`,
   * which is the same predicate such a tier would apply, so it could never
   * discriminate between two candidates that reached the comparator. The cases
   * that used to live here built out-of-cycle `Backlog` candidates the CLI
   * cannot produce. What does discriminate regardless of cycle/state is the
   * unblocks dimension:
   */
  it('ranks by unblocks regardless of cycle membership or state name', () => {
    const todoNoUnblocks = makeCandidate({
      identifier: 'RAN-500',
      stateName: 'Todo',
      unblocks: 0,
    })
    const cycleUnblocker = makeCandidate({
      identifier: 'RAN-600',
      inCycle: true,
      stateName: 'Backlog',
      unblocks: 1,
    })
    const pool = makePool([todoNoUnblocks, cycleUnblocker])
    const unblocksMap = new Map([[id('RAN-600'), [id('RAN-700')]]])

    const result = pick(pool, new Set(), unblocksMap)

    expect(result?.chosen.identifier).toBe('RAN-600')
    expect(result?.reason).toContain('blocks RAN-700')
  })

  it('lets priority win over cycle membership, which no longer ranks', () => {
    /**
     * The inverse of the removed tier: an in-cycle candidate with no priority
     * does NOT beat an Urgent one. Guards against the tier being reintroduced
     * without also loosening eligibility.
     */
    const inCycleNoPriority = makeCandidate({
      identifier: 'RAN-100',
      inCycle: true,
      stateName: 'Todo',
      priority: 0,
    })
    const urgentTodo = makeCandidate({
      identifier: 'RAN-200',
      inCycle: false,
      stateName: 'Todo',
      priority: 1,
    })
    const pool = makePool([inCycleNoPriority, urgentTodo])

    const result = pick(pool, new Set(), new Map())

    expect(result?.chosen.identifier).toBe('RAN-200')
    expect(result?.reason).toContain('Urgent')
  })

  it('reports a tied reason when two candidates match on every dimension', () => {
    /** Both candidates identical on every ranking dimension. The reason must
     * acknowledge the tie rather than falsely claim "only eligible candidate". */
    const a = makeCandidate({
      identifier: 'RAN-1',
      priority: 0,
      unblocks: 0,
      createdAt: '2024-01-01T00:00:00.000Z',
    })
    const b = makeCandidate({
      identifier: 'RAN-2',
      priority: 0,
      unblocks: 0,
      createdAt: '2024-01-01T00:00:00.000Z',
    })
    const pool = makePool([a, b])

    const result = pick(pool, new Set(), new Map())

    expect(result?.reason).toContain('tied')
    expect(result?.reason).not.toContain('only eligible candidate')
  })
})
