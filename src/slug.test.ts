/**
 * Unit tests for buildBranchName. Each case targets a distinct transformation
 * rule: basic slugification, article-stripping, punctuation removal, truncation
 * at a word boundary, and diacritic folding.
 */

import { describe, expect, it } from 'vitest'

import { buildBranchName } from './slug.ts'

describe('buildBranchName', () => {
  it('produces kebab-case id prefix + title slug', () => {
    expect(buildBranchName('RAN-30', 'Roulator fall-through to past-maybes bucket')).toBe(
      'ran-30-roulator-fall-through-to-past-maybes-bucket',
    )
  })

  it('strips a leading "the" article', () => {
    expect(buildBranchName('RAN-9', 'The big refactor')).toBe('ran-9-big-refactor')
  })

  it('strips a leading "a" article', () => {
    expect(buildBranchName('RAN-9', 'A small fix')).toBe('ran-9-small-fix')
  })

  it('strips a leading "an" article', () => {
    expect(buildBranchName('RAN-9', 'An important update')).toBe('ran-9-important-update')
  })

  it('removes punctuation and replaces it with hyphens', () => {
    /**
     * The full branch name exceeds 50 chars, so it is truncated at the last
     * word boundary: "cwe-502" gets dropped, leaving "cwe" as the final segment.
     */
    expect(buildBranchName('RAN-16', 'Bump @ungap/structured-clone past 1.3.0 (CWE-502)')).toBe(
      'ran-16-bump-ungap-structured-clone-past-1-3-0-cwe',
    )
  })

  it('truncates at a word boundary so the full branch name is ≤ 50 chars', () => {
    const result = buildBranchName(
      'RAN-100',
      'Add comprehensive integration test suite for the new event pagination endpoint',
    )
    expect(result.length).toBeLessThanOrEqual(50)
    expect(result).not.toMatch(/-$/)
    expect(result).toBe('ran-100-add-comprehensive-integration-test-suite')
  })

  it('folds diacritics to their ASCII base characters', () => {
    expect(buildBranchName('RAN-1', 'Café renovation')).toBe('ran-1-cafe-renovation')
  })

  it('drops the trailing dash when the title slugifies to empty', () => {
    /**
     * An all-punctuation title produces an empty slug. The branch name
     * must not end with a hyphen — git rejects refs that do.
     */
    expect(buildBranchName('RAN-1', '!!!')).toBe('ran-1')
    expect(buildBranchName('RAN-1', '')).toBe('ran-1')
  })
})
