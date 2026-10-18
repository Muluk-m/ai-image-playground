import { fileURLToPath } from 'node:url'
import { startVitest } from '../apps/web/node_modules/vitest/dist/node.js'

const root = fileURLToPath(new URL('../apps/web', import.meta.url))
const context = await startVitest('test', process.argv.slice(2), {
  root,
  config: `${root}/vite.config.ts`,
  envDir: false,
  watch: false,
  maxWorkers: 1,
  fileParallelism: false,
})
if (!context) process.exitCode = 1
else await context.close()
