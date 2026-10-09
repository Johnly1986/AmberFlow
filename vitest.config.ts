import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `integrations/dsh-bridge` is a self-contained package (its own config, its own DSH-side
    // dependencies). Without this line its `tests/*.spec.ts` join this suite's run and break it —
    // measured: a probe spec under a nested directory was collected by the default include.
    exclude: [...configDefaults.exclude, 'integrations/**'],
  },
})
