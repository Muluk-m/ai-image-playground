import { defineConfig } from 'vitest/config'
import { parseCLI } from 'vitest/node'
import { vitestGuard } from '../../scripts/test-guard'

export default defineConfig({
  test: { ...vitestGuard('apps/website', parseCLI), include: ['src/__tests__/**/*.test.ts'] },
})
