import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Every rollout replaces the release router with one on the release image. The old router is
// stopped while requests may still be passing through it; they must finish, not be cut.

const router = resolve(import.meta.dir, '../../../../../scripts/release-router.ts')
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as { port: number }
  await new Promise((done) => server.close(done))
  return port
}

async function waitUntilListening(port: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`)
      return
    } catch {
      await Bun.sleep(25)
    }
  }
  throw new Error('router did not start')
}

describe('release router', () => {
  it('finishes a request in flight when it is stopped, and then exits', async () => {
    let release: () => void = () => {}
    const upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        if (new URL(request.url).pathname === '/domain-check') {
          return new Response(null, {
            status: new URL(request.url).host === 'api.new.example' ? 204 : 404,
          })
        }
        if (new URL(request.url).pathname !== '/slow') return new Response('ok')
        await new Promise<void>((done) => {
          release = done
        })
        return new Response('finished after stop')
      },
    })
    cleanups.push(() => upstream.stop(true))
    const dir = await mkdtemp(join(tmpdir(), 'aip-router-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const routeFile = join(dir, 'route.json')
    // The router only accepts container-style origins; `localhost` is one.
    await writeFile(routeFile, JSON.stringify({ origin: `http://localhost:${upstream.port}` }))
    const port = await freePort()
    const child = Bun.spawn(['bun', router], {
      env: {
        ...process.env,
        RELEASE_ROUTE_FILE: routeFile,
        RELEASE_ROUTER_PORT: String(port),
        RELEASE_ORIGIN_PORT: String(upstream.port),
      },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    cleanups.push(() => child.kill('SIGKILL'))
    await waitUntilListening(port)
    const recognized = await fetch(`http://127.0.0.1:${port}/domain-check`, {
      headers: { host: 'api.new.example' },
    })
    expect(recognized.status).toBe(204)
    const rejected = await fetch(`http://127.0.0.1:${port}/domain-check`, {
      headers: { host: 'untrusted.example', 'x-forwarded-host': 'api.new.example' },
    })
    expect(rejected.status).toBe(404)

    const inFlight = fetch(`http://127.0.0.1:${port}/slow`)
    await Bun.sleep(100)
    child.kill('SIGTERM')
    await Bun.sleep(100)
    release()

    const response = await inFlight
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('finished after stop')
    expect(await child.exited).toBe(0)
  })
})
