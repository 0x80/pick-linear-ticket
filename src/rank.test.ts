/**
 * Unit tests for pickCandidate. Each case targets a distinct ranking rule or
 * edge condition: empty pool, sole candidate, blocker filtering, the promoted
 * tier (in-cycle OR `Todo`), and the three tiebreak dimensions inside the
 * tier (unblocks, priority, createdAt).
 */

import { describe, expect, it } from 'vitest'

import type { Candidate, CandidatePool, Identifier } from './types.ts'
import { pickCandidate } from './rank.ts'

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
 * `stateName` defaults to `'Backlog'` because that is the non-promoted baseline
 * — using `'Todo'` (which `isPromoted` recognizes) would silently push every
 * default candidate into the promoted tier and mask bugs in tests that aren't
 * explicitly about the tier dimension.
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
  return new Map(candidates.map((c) => [c.identifier as Identifier, c]))
}

describe('pickCandidate', () => {
  it('returns no-candidates when the pool is empty', () => {
    const result = pickCandidate(new Map(), new Set(), new Map())
    expect(result.kind).toBe('no-candidates')
    if (result.kind === 'no-candidates') {
      expect(result.why).toBe('active cycle empty; backlog empty after blocking/assignment filters')
    }
  })

  it('returns chosen with reason "only eligible candidate" for a single candidate', () => {
    const candidate = makeCandidate({ identifier: 'RAN-1' })
    const pool = makePool([candidate])

    const result = pickCandidate(pool, new Set(), new Map())

    expect(result.kind).toBe('chosen')
    if (result.kind === 'chosen') {
      expect(result.issue).toBe(candidate)
      expect(result.reason).toBe('only eligible candidate')
    }
  })

  it('drops a candidate blocked by an active issue', () => {
    /** RAN-2 is active, so RAN-1 (which is blocked by RAN-2) should be filtered. */
    const blocked = makeCandidate({ identifier: 'RAN-1', blockedBy: [id('RAN-2')] })
    const pool = makePool([blocked])
    const activeIdentifiers = new Set([id('RAN-2')])

    const result = pickCandidate(pool, activeIdentifiers, new Map())

    expect(result.kind).toBe('no-candidates')
  })

  it('keeps a candidate whose blocker is no longer active', () => {
    /** RAN-3 is NOT in activeIdentifiers (already done/canceled), so RAN-1 survives. */
    const candidate = makeCandidate({ identifier: 'RAN-1', blockedBy: [id('RAN-3')] })
    const pool = makePool([candidate])
    const activeIdentifiers = new Set<Identifier>() // RAN-3 is not active

    const result = pickCandidate(pool, activeIdentifiers, new Map())

    expect(result.kind).toBe('chosen')
  })

  it('picks the candidate with more unblocks, and reason mentions a downstream id', () => {
    const candidateA = makeCandidate({ identifier: 'RAN-11', unblocks: 1 })
    const candidateB = makeCandidate({ identifier: 'RAN-12', unblocks: 0 })
    const pool = makePool([candidateA, candidateB])
    const unblocksMap = new Map([[id('RAN-11'), [id('RAN-99')]]])

    const result = pickCandidate(pool, new Set(), unblocksMap)

    expect(result.kind).toBe('chosen')
    if (result.kind === 'chosen') {
      expect(result.issue.identifier).toBe('RAN-11')
      expect(result.reason).toContain('blocks RAN-99')
    }
  })

  it('picks the highest-priority candidate when unblocks are equal', () => {
    /** Priority 1 = Urgent, 3 = Medium, 0 = No priority. Urgent wins. */
    const urgent = makeCandidate({ identifier: 'RAN-10', priority: 1, unblocks: 0 })
    const medium = makeCandidate({ identifier: 'RAN-20', priority: 3, unblocks: 0 })
    const noPriority = makeCandidate({ identifier: 'RAN-30', priority: 0, unblocks: 0 })
    const pool = makePool([urgent, medium, noPriority])

    const result = pickCandidate(pool, new Set(), new Map())

    expect(result.kind).toBe('chosen')
    if (result.kind === 'chosen') {
      expect(result.issue.identifier).toBe('RAN-10')
      expect(result.reason).toContain('Urgent')
    }
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

    const result = pickCandidate(pool, new Set(), new Map())

    expect(result.kind).toBe('chosen')
    if (result.kind === 'chosen') {
      expect(result.issue.identifier).toBe('RAN-1')
      expect(result.reason).toContain('oldest by createdAt')
    }
  })

  it('in-cycle candidate beats a higher-priority out-of-cycle backlog candidate', () => {
    /** X is in-cycle with no priority; Y is out-of-cycle Backlog with Urgent priority. X wins. */
    const inCycleCandidate = makeCandidate({
      identifier: 'RAN-100',
      inCycle: true,
      stateName: 'Backlog',
      priority: 0,
      createdAt: '2024-06-01T00:00:00.000Z', // later
    })
    const urgentBacklog = makeCandidate({
      identifier: 'RAN-200',
      inCycle: false,
      stateName: 'Backlog',
      priority: 1,
      createdAt: '2024-01-01T00:00:00.000Z', // earlier
    })
    const pool = makePool([inCycleCandidate, urgentBacklog])

    const result = pickCandidate(pool, new Set(), new Map())

    expect(result.kind).toBe('chosen')
    if (result.kind === 'chosen') {
      expect(result.issue.identifier).toBe('RAN-100')
      expect(result.reason).toContain('in active cycle')
    }
  })

  it('Todo candidate beats a higher-priority Backlog candidate', () => {
    /** Todo (promoted) beats Backlog (not promoted) regardless of priority. */
    const todoCandidate = makeCandidate({
      identifier: 'RAN-300',
      inCycle: false,
      stateName: 'Todo',
      priority: 0,
    })
    const urgentBacklog = makeCandidate({
      identifier: 'RAN-400',
      inCycle: false,
      stateName: 'Backlog',
      priority: 1,
    })
    const pool = makePool([todoCandidate, urgentBacklog])

    const result = pickCandidate(pool, new Set(), new Map())

    expect(result.kind).toBe('chosen')
    if (result.kind === 'chosen') {
      expect(result.issue.identifier).toBe('RAN-300')
      expect(result.reason).toContain('marked as Todo')
    }
  })

  it('inside the promoted tier, unblocks breaks the tie', () => {
    /** Both promoted (one Todo, one in-cycle Backlog) — the one that unblocks more wins. */
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

    const result = pickCandidate(pool, new Set(), unblocksMap)

    expect(result.kind).toBe('chosen')
    if (result.kind === 'chosen') {
      expect(result.issue.identifier).toBe('RAN-600')
      expect(result.reason).toContain('blocks RAN-700')
    }
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

    const result = pickCandidate(pool, new Set(), new Map())

    expect(result.kind).toBe('chosen')
    if (result.kind === 'chosen') {
      expect(result.reason).toContain('tied')
      expect(result.reason).not.toContain('only eligible candidate')
    }
  })
})
