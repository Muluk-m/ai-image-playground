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
    const origin = `http://127.0.0.1:${address.port}`
    const response = await fetch(`${origin}/cli/muvloom-workbuddy.zip`)
    expect(response.status).toBe(200)
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()))
    expect(strFromU8(files['muvloom/SKILL.md'])).toContain(
      '[WorkBuddy setup](references/workbuddy.md)',
    )
    expect(files['muvloom/references/workbuddy.md']).toBeDefined()
    const doubao = await fetch(`${origin}/cli/muvloom-doubao.zip`)
    expect(doubao.status).toBe(200)
    const doubaoFiles = unzipSync(new Uint8Array(await doubao.arrayBuffer()))
    expect(strFromU8(doubaoFiles['muvloom/SKILL.md'])).toContain(
      '[Doubao Work setup](references/doubao.md)',
    )
    const generic = await fetch(`${origin}/cli/muvloom-skill.zip`)
    expect(generic.status).toBe(200)
    expect(
      strFromU8(unzipSync(new Uint8Array(await generic.arrayBuffer()))['muvloom/SKILL.md']),
    ).toContain('name: muvloom')
    const install = await fetch(`${origin}/cli/install.sh`)
    expect(install.status).toBe(200)
    expect(await install.text()).toContain('MUVLOOM_MIN_VERSION')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await vite.close()
  }
}, 30_000)
