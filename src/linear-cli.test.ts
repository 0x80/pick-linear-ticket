/**
 * Unit tests for the connection paginator. The relations query can only ask
 * for ~50 issues at a time before Linear rejects it on query complexity, so
 * completeness of the blocker graph rests entirely on walking every page —
 * these cover the walk's termination, its cursor threading, and the two
 * defensive exits (no cursor, page guard).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { type IssuePage, collectIssuePages } from './linear-cli.ts'

/** Silences the paginator's stderr warnings and captures them for assertions. */
function captureStderr(): { text: () => string } {
  const written: string[] = []
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    written.push(String(chunk))
    return true
  })
  return { text: () => written.join('') }
}

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

  it('stops and warns when a further page is claimed but no cursor is returned', async () => {
    const stderr = captureStderr()
    const { fetchPage } = pagedSource([{ nodes: ['a'], hasNextPage: true, endCursor: undefined }])
    expect(await collectIssuePages(fetchPage, 'activeSetRelations')).toEqual(['a'])
    expect(stderr.text()).toMatch(/activeSetRelations.*no cursor/)
  })

  it('stops at the page guard when the connection never reports a last page', async () => {
    const stderr = captureStderr()
    let calls = 0
    const fetchPage = (): Promise<IssuePage<string>> => {
      calls++
      return Promise.resolve({ nodes: ['a'], hasNextPage: true, endCursor: `c${calls}` })
    }
    const result = await collectIssuePages(fetchPage, 'listAllIssues')
    expect(calls).toBe(20)
    expect(result).toHaveLength(20)
    expect(stderr.text()).toMatch(/listAllIssues stopped at the 20-page guard/)
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
