/**
 * Unit tests for the connection paginator and the query adapter above it. The
 * relations query can only ask for ~50 issues at a time before Linear rejects
 * it on query complexity, so completeness of the blocker graph rests entirely
 * on walking every page — these cover the walk's termination, its cursor
 * threading, and every guard that refuses to return a partial result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ExecaModule from 'execa'

/**
 * `linear-cli` is never spawned here. Mocking `execa` lets the adapter-level
 * tests drive `fetchActiveIssues` through its real GraphQL construction and
 * response parsing, which is where a missing `pageInfo` selection or an
 * unthreaded `after:` argument would actually hide — the paginator tests below
 * take a callback and so cannot see any of it. Only `execa` itself is replaced;
 * the rest of the module (notably `ExecaError`, which `runLinear` checks with
 * `instanceof`) is kept so error handling still behaves.
 */
vi.mock('execa', async (importOriginal) => {
  const actual = await importOriginal<typeof ExecaModule>()
  return { ...actual, execa: vi.fn() }
})

import { execa } from 'execa'
import {
  type IssuePage,
  MAX_ISSUE_PAGES,
  PaginationError,
  activeSetRelations,
  collectIssuePages,
  listAllIssues,
} from './linear-cli.ts'
import { MISSING_CREATED_AT } from './types.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * Builds a `fetchPage` that serves `pages` in order, recording the cursor it
 * was called with each time.
 */
function pagedSource<T>(pages: IssuePage<T>[]): {
  fetchPage: (cursor: string | undefined) => Promise<IssuePage<T>>
  cursors: (string | undefined)[]
} {
  const cursors: (string | undefined)[] = []
  let index = 0
  return {
    cursors,
    fetchPage: (cursor) => {
      cursors.push(cursor)
      const page = pages[index++]
      if (!page) throw new Error('fetchPage called more times than there are pages')
      return Promise.resolve(page)
    },
  }
}

describe('collectIssuePages', () => {
  it('returns a single page without asking for another', async () => {
    const { fetchPage, cursors } = pagedSource([
      { nodes: ['a', 'b'], hasNextPage: false, endCursor: 'c1' },
    ])
    expect(await collectIssuePages(fetchPage, 'test')).toEqual(['a', 'b'])
    expect(cursors).toEqual([undefined])
  })

  it('concatenates every page in order', async () => {
    const { fetchPage } = pagedSource([
      { nodes: ['a', 'b'], hasNextPage: true, endCursor: 'c1' },
      { nodes: ['c'], hasNextPage: true, endCursor: 'c2' },
      { nodes: ['d', 'e'], hasNextPage: false, endCursor: 'c3' },
    ])
    expect(await collectIssuePages(fetchPage, 'test')).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('threads each page cursor into the next request', async () => {
    const { fetchPage, cursors } = pagedSource([
      { nodes: ['a'], hasNextPage: true, endCursor: 'c1' },
      { nodes: ['b'], hasNextPage: true, endCursor: 'c2' },
      { nodes: ['c'], hasNextPage: false, endCursor: 'c3' },
    ])
    await collectIssuePages(fetchPage, 'test')
    expect(cursors).toEqual([undefined, 'c1', 'c2'])
  })

  it('covers more issues than one page holds', async () => {
    /**
     * The regression this whole change exists for: a 50-issue window over a
     * 75-issue active set silently dropped the tail, so `blocks` edges on the
     * last 25 issues never reached the ranking.
     */
    const first = Array.from({ length: 50 }, (_, i) => `RAN-${i}`)
    const second = Array.from({ length: 25 }, (_, i) => `RAN-${50 + i}`)
    const { fetchPage } = pagedSource([
      { nodes: first, hasNextPage: true, endCursor: 'c1' },
      { nodes: second, hasNextPage: false, endCursor: 'c2' },
    ])
    expect(await collectIssuePages(fetchPage, 'test')).toHaveLength(75)
  })

  /**
   * The three guards below all throw rather than returning the nodes gathered
   * so far. A partial list is indistinguishable from a complete one at the call
   * site, so returning it would silently restore the truncated-blocker-graph
   * bug that pagination exists to fix.
   */
  it('throws when a further page is claimed but no cursor is returned', async () => {
    const { fetchPage } = pagedSource([{ nodes: ['a'], hasNextPage: true, endCursor: undefined }])
    await expect(collectIssuePages(fetchPage, 'activeSetRelations')).rejects.toBeInstanceOf(
      PaginationError,
    )
  })

  it('throws when the cursor stops advancing instead of refetching the same page', async () => {
    let calls = 0
    const fetchPage = (): Promise<IssuePage<string>> => {
      calls++
      return Promise.resolve({ nodes: ['a'], hasNextPage: true, endCursor: 'stuck' })
    }
    await expect(collectIssuePages(fetchPage, 'activeSetRelations')).rejects.toThrow(
      /repeated cursor/,
    )
    /** Caught on the second request, not after burning the whole page bound. */
    expect(calls).toBe(2)
  })

  it('throws when the connection never reports a last page', async () => {
    let calls = 0
    const fetchPage = (): Promise<IssuePage<string>> => {
      calls++
      return Promise.resolve({ nodes: ['a'], hasNextPage: true, endCursor: `c${calls}` })
    }
    await expect(collectIssuePages(fetchPage, 'listAllIssues')).rejects.toThrow(
      new RegExp(`${MAX_ISSUE_PAGES}-page bound`),
    )
    expect(calls).toBe(MAX_ISSUE_PAGES)
  })

  it('handles an empty connection', async () => {
    const { fetchPage } = pagedSource<string>([
      { nodes: [], hasNextPage: false, endCursor: undefined },
    ])
    expect(await collectIssuePages(fetchPage, 'test')).toEqual([])
  })

  it('propagates a page fetch failure instead of returning a partial result', async () => {
    const fetchPage = (): Promise<IssuePage<string>> =>
      Promise.reject(new Error('linear-cli blew up'))
    await expect(collectIssuePages(fetchPage, 'test')).rejects.toThrow('linear-cli blew up')
  })
})

/**
 * Adapter-level coverage: these drive the real GraphQL construction and
 * response parsing with `linear-cli` mocked out, so a dropped `pageInfo`
 * selection, an unthreaded cursor, or a missing field in the node selection
 * fails here rather than silently truncating a real pick.
 */
describe('fetchActiveIssues (via its public callers)', () => {
  const config = {
    teamKey: 'RAN',
    teamName: 'randezvous',
    teamId: 'team-uuid',
    workspace: 'emberengineering',
  }

  /** The queries `execa` was called with, in order. */
  let queries: string[]

  /** Queues one GraphQL response per call, in order. */
  function respondWith(pages: unknown[]): void {
    let index = 0
    vi.mocked(execa).mockImplementation(((_bin: string, args: string[]) => {
      queries.push(args[2] ?? '')
      const body = pages[index++]
      if (body === undefined) throw new Error('execa called more times than there are pages')
      return Promise.resolve({ stdout: JSON.stringify(body) })
    }) as unknown as typeof execa)
  }

  /** Builds a `team.issues` connection response envelope. */
  function connection(nodes: unknown[], hasNextPage: boolean, endCursor: string | null): unknown {
    return { data: { team: { issues: { pageInfo: { hasNextPage, endCursor }, nodes } } } }
  }

  beforeEach(() => {
    queries = []
    vi.mocked(execa).mockReset()
  })

  it('asks for pageInfo so the walk can ever terminate', async () => {
    respondWith([connection([], false, null)])
    await activeSetRelations(config)
    expect(queries[0]).toMatch(/pageInfo\s*{\s*hasNextPage\s+endCursor\s*}/)
  })

  it('omits `after` on the first page and threads the cursor into the second', async () => {
    respondWith([
      connection([{ identifier: 'RAN-1', relations: { nodes: [] } }], true, 'cursor-1'),
      connection([{ identifier: 'RAN-2', relations: { nodes: [] } }], false, 'cursor-2'),
    ])
    await activeSetRelations(config)
    expect(queries).toHaveLength(2)
    expect(queries[0]).not.toMatch(/after:/)
    expect(queries[1]).toMatch(/after: "cursor-1"/)
  })

  it('returns blocks edges from every page, not just the first', async () => {
    respondWith([
      connection(
        [
          {
            identifier: 'RAN-1',
            relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: 'RAN-9' } }] },
          },
        ],
        true,
        'cursor-1',
      ),
      connection(
        [
          {
            identifier: 'RAN-2',
            relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: 'RAN-8' } }] },
          },
        ],
        false,
        null,
      ),
    ])
    /** The whole point of the change: a second-page blocker is still an edge. */
    expect(await activeSetRelations(config)).toEqual([
      { identifier: 'RAN-1', blocks: ['RAN-9'] },
      { identifier: 'RAN-2', blocks: ['RAN-8'] },
    ])
  })

  it('ignores relation types other than blocks', async () => {
    respondWith([
      connection(
        [
          {
            identifier: 'RAN-1',
            relations: {
              nodes: [
                { type: 'related', relatedIssue: { identifier: 'RAN-9' } },
                { type: 'duplicate', relatedIssue: { identifier: 'RAN-7' } },
              ],
            },
          },
        ],
        false,
        null,
      ),
    ])
    expect(await activeSetRelations(config)).toEqual([{ identifier: 'RAN-1', blocks: [] }])
  })

  it('selects createdAt and preserves it, so the oldest-wins tiebreak has real data', async () => {
    respondWith([
      connection(
        [
          {
            identifier: 'RAN-1',
            title: 'First',
            priority: 2,
            state: { name: 'Todo' },
            assignee: null,
            url: 'https://linear.app/x/issue/RAN-1',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        false,
        null,
      ),
    ])
    const issues = await listAllIssues(config)
    expect(queries[0]).toMatch(/createdAt/)
    expect(issues[0]?.createdAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('falls back to MISSING_CREATED_AT so an unknown timestamp sorts last, not first', async () => {
    respondWith([connection([{ identifier: 'RAN-1', title: 'No timestamp' }], false, null)])
    const issues = await listAllIssues(config)
    expect(issues[0]?.createdAt).toBe(MISSING_CREATED_AT)
  })

  it('drops nodes whose identifier is not a valid Linear identifier', async () => {
    respondWith([
      connection(
        [{ identifier: 'not-an-id' }, { identifier: 'RAN-2', title: 'Real' }],
        false,
        null,
      ),
    ])
    const issues = await listAllIssues(config)
    expect(issues.map((i) => i.identifier)).toEqual(['RAN-2'])
  })
})
