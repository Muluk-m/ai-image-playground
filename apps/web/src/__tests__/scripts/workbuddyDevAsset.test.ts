// @vitest-environment node
import { createServer as createHttpServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { strFromU8, unzipSync } from 'fflate'
import { createServer } from 'vite'
import { expect, it, vi } from 'vitest'

it('serves the generated WorkBuddy ZIP from the actual development configuration', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  // The outer Vitest run keeps its guard; this nested config belongs to a dev server.
  vi.stubEnv('VITEST', undefined)
  const vite = await createServer({
    root,
    configFile: `${root}vite.config.ts`,
    mode: 'development',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  }).finally(() => vi.unstubAllEnvs())
  const server = createHttpServer(vite.middlewares)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test server address')
    const response = await fetch(`http://127.0.0.1:${address.port}/cli/muvloom-workbuddy.zip`)
    expect(response.status).toBe(200)
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()))
    expect(strFromU8(files['muvloom/SKILL.md'])).toContain(
      '[WorkBuddy setup](references/workbuddy.md)',
    )
    expect(files['muvloom/references/workbuddy.md']).toBeDefined()
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await vite.close()
  }
}, 30_000)
