import { defineConfig } from 'vitest/config'

/**
 * Local Vitest config so `pnpm test --filter @repo/pick-ticket` runs only
 * this package's suites and doesn't try to orchestrate the rest of the
 * monorepo.
 */
export default defineConfig({
  test: {
    passWithNoTests: true,
  },
})
