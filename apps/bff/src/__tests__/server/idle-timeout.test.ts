import { afterAll, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { SERVER_IDLE_TIMEOUT_SEC } from '@image-playground/shared'

/**
 * 回归：源站不得先于反代关掉池子里的空闲连接。不给 `listen` 传 `idleTimeout` 时
 * 生效的 Elysia Bun adapter 默认 30s 跟 cloudflared 的 30s 撞平，对用户就是随机
 * 502（2026-08-10 线上事故；完整机制见 `SERVER_IDLE_TIMEOUT_SEC` 的注释）。
 *
 * 起真进程、走真 socket——`app.handle(Request)` 那种内存调用碰不到连接生命周期，
 * 而且只有子进程才能验到 `src/index.ts` 里真正传出去的 listen 配置。
 *
 * 真实 wall-clock 等待在这里是 no-test-timers 规则的例外：被测的空闲计时器跑在
 * 另一个 OS 进程的 Bun 事件循环里，本进程的 fake timer 推不动它，没有可 await
 * 的信号能替代——服务端「没关连接」这件事只能靠真的等过阈值来观察。
 */

const TEST_DB = await resetTestDatabase('bff_idle_timeout')
/** 未修复时生效的空闲超时（Elysia Bun adapter 默认值）。 */
const ELYSIA_DEFAULT_IDLE_SEC = 30
/** 必须越过未修复时的阈值，否则测不出「服务端提前关连接」。 */
const IDLE_GAP_MS = (ELYSIA_DEFAULT_IDLE_SEC + 5) * 1000
const SOCKET_WAIT_MS = 5_000
const HEALTH_WAIT_MS = 30_000

function reserveFreePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const { port } = probe
  probe.stop(true)
  if (port === undefined) throw new Error('Bun.serve did not report a TCP port')
  return port
}

const port = reserveFreePort()
const server = Bun.spawn(['bun', 'run', 'src/index.ts'], {
  env: {
    ...process.env,
    PORT: String(port),
    DATABASE_URL: TEST_DB,
    UPSTREAM_BASE_URL: 'http://localhost:9999',
    UPSTREAM_API_KEY: 'test',
    CORS_ALLOWED_ORIGINS: '*',
  },
  stdout: 'ignore',
  stderr: 'ignore',
})

afterAll(() => {
  server.kill()
})

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + HEALTH_WAIT_MS
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      if (res.ok) {
        await res.text()
        return
      }
    } catch {
      // 进程还没 listen，退避重试
    }
    await Bun.sleep(200)
  }
  throw new Error(`bff did not become healthy on port ${port}`)
}

async function openKeepAlive() {
  let buffer = ''
  let isClosed = false
  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      data(_s, chunk) {
        buffer += chunk.toString()
      },
      close() {
        isClosed = true
      },
      error() {
        isClosed = true
      },
    },
  })

  return {
    closed: () => isClosed,
    end: () => socket.end(),
    /** 发一次 /health 并等完整响应；连接已被对端关闭则 reject。 */
    async request() {
      buffer = ''
      const written = socket.write(
        'GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n',
      )
      if (written === 0 || isClosed) {
        throw new Error('connection already closed by origin before the request was written')
      }
      const deadline = Date.now() + SOCKET_WAIT_MS
      while (Date.now() < deadline) {
        if (buffer.includes('{"ok":true}')) return buffer
        if (isClosed) {
          throw new Error(`connection closed by origin mid-response (got ${buffer.length} bytes)`)
        }
        await Bun.sleep(50)
      }
      throw new Error(`no response within ${SOCKET_WAIT_MS}ms (got ${buffer.length} bytes)`)
    },
  }
}

describe('bff keep-alive idle timeout', () => {
  it('outlasts every reverse proxy the deployment puts in front of it', () => {
    // 反代池子最长的一档是 cloudflared 默认的 1m30s；源站必须严格大于它，
    // 相等都不行（撞平就是 2026-08-10 那次事故）。
    expect(SERVER_IDLE_TIMEOUT_SEC).toBeGreaterThan(90)
    expect(IDLE_GAP_MS / 1000).toBeLessThan(SERVER_IDLE_TIMEOUT_SEC)
  })

  it(
    'serves a second request on a connection left idle past the unfixed threshold',
    async () => {
      await waitForHealth()
      const conn = await openKeepAlive()
      try {
        expect(await conn.request()).toContain('200')

        await Bun.sleep(IDLE_GAP_MS)
        expect(conn.closed()).toBe(false)

        expect(await conn.request()).toContain('200')
      } finally {
        conn.end()
      }
    },
    IDLE_GAP_MS + 60_000,
  )
})
