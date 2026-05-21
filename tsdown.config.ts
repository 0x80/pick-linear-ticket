import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: 'esm',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  shims: false,
})
