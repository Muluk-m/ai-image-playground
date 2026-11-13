import { defineConfig } from 'vitest/config'
import { parseCLI } from 'vitest/node'
import { vitestGuard } from '../../scripts/test-guard'
import { cliBuildDefines } from '../web/scripts/cli-build-defines.mjs'

export default defineConfig({
  define: cliBuildDefines(),
  test: { ...vitestGuard('apps/website', parseCLI), include: ['src/__tests__/**/*.test.ts'] },
})
