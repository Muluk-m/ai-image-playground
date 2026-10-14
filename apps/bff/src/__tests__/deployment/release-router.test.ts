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

  it('relays binary canvas frames and the public host, cookie and origin', async () => {
    let seen: { host: string; cookie: string | null; origin: string | null } | undefined
    const upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request, bunServer) {
        if (request.headers.get('upgrade') !== 'websocket') return new Response('ok')
        const url = new URL(request.url)
        seen = {
          host: url.host,
          cookie: request.headers.get('cookie'),
          origin: request.headers.get('origin'),
        }
        if (!bunServer.upgrade(request)) return new Response('upgrade failed', { status: 426 })
        return undefined
      },
      websocket: {
        open(ws) {
          ws.send('ready')
        },
        message(ws, message) {
          ws.send(message)
        },
      },
    })
    cleanups.push(() => upstream.stop(true))
    const dir = await mkdtemp(join(tmpdir(), 'aip-router-ws-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    await writeFile(
      join(dir, 'route.json'),
      JSON.stringify({ origin: `http://localhost:${upstream.port}` }),
    )
    const port = await freePort()
    const child = Bun.spawn(['bun', router], {
      env: {
        ...process.env,
        RELEASE_ROUTE_FILE: join(dir, 'route.json'),
        RELEASE_ROUTER_PORT: String(port),
        RELEASE_ORIGIN_PORT: String(upstream.port),
      },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    cleanups.push(() => child.kill('SIGKILL'))
    await waitUntilListening(port)

    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/projects/one/canvas/ws`, {
      headers: {
        cookie: 'image_playground_session=session-token',
        host: 'api.new.example',
        origin: 'https://test.muvloom.online',
      },
    })
    cleanups.push(() => socket.close())
    const frames: Array<string | number[]> = []
    socket.binaryType = 'arraybuffer'
    socket.addEventListener('message', (event) => {
      frames.push(
        typeof event.data === 'string'
          ? event.data
          : [...new Uint8Array(event.data as ArrayBuffer)],
      )
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket did not open')), 3_000)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('socket failed'))
      })
    })
    socket.send(new Uint8Array([9, 8, 7]))
    for (let attempt = 0; attempt < 40 && frames.length < 2; attempt++) await Bun.sleep(25)

    expect(seen).toEqual({
      host: 'api.new.example',
      cookie: 'image_playground_session=session-token',
      origin: 'https://test.muvloom.online',
    })
    expect(frames).toEqual(['ready', [9, 8, 7]])
  })
})
