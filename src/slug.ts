import type { Identifier } from './types.ts'

/** Articles to strip from the leading position of a slug. */
const LEADING_ARTICLES = ['the-', 'an-', 'a-']

/** Converts a title string to a URL-safe slug segment. */
function slugify(title: string): string {
  const normalized = title.normalize('NFKD').replaceAll(/\p{M}/gu, '')
  const lower = normalized.toLowerCase()
  const hyphenated = lower.replaceAll(/[^a-z0-9]+/g, '-')
  const trimmed = hyphenated.replaceAll(/^-+|-+$/g, '')

  for (const article of LEADING_ARTICLES) {
    if (trimmed.startsWith(article)) {
      return trimmed.slice(article.length)
    }
  }

  return trimmed
}

/** Truncates a slug to fit within `budget` characters, cutting at a word boundary. */
function truncateAtWordBoundary(slug: string, budget: number): string {
  if (slug.length <= budget) return slug
  const candidate = slug.slice(0, budget)
  const lastDash = candidate.lastIndexOf('-')
  if (lastDash <= 0) return candidate.replace(/-+$/, '')
  return slug.slice(0, lastDash)
}

/**
 * Builds a git branch name from a Linear issue identifier and title.
 *
 * The result is at most 50 characters total, lower-cased, with words separated
 * by hyphens. Leading articles ("a", "an", "the") are stripped from the title
 * slug. The full branch name never exceeds 50 characters; truncation happens at
 * the nearest word boundary below the limit.
 */
export function buildBranchName(id: Identifier | string, title: string): string {
  const lowerId = id.toLowerCase()
  const slug = slugify(title)
  const budget = 50 - (lowerId.length + 1)
  const truncated = truncateAtWordBoundary(slug, budget)
  /**
   * Strip any trailing dash. This can happen when the title slugifies to
   * empty (all-punctuation title), and would otherwise produce an invalid
   * git ref like `ran-30-`.
   */
  return `${lowerId}-${truncated}`.replace(/-+$/, '')
}
