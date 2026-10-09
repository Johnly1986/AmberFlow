import { defineConfig } from 'vitest/config'

/**
 * Standalone test configuration.
 *
 * The host packages this plugin imports (`@deepseek-ai/cordis`, `-dsh-tools`, `-schemastery`, …) are
 * linked into `node_modules` by `npm run setup` and resolve through their ordinary package entries —
 * no path aliases, so a test run sees exactly what a consumer of this package would see.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    // The live suite drives a browser and the real checkout; serial files bound peak memory.
    fileParallelism: false,
  },
})
