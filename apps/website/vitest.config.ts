import { defineConfig } from 'vitest/config'
import { vitestGuard } from '../../scripts/test-guard'

export default defineConfig({
  test: { ...vitestGuard('apps/website'), include: ['src/__tests__/**/*.test.ts'] },
})
