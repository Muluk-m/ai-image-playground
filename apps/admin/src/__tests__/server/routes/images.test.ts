import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'

const TEST_DB = await resetTestDatabase('admin_images_route')
// 启一个 mock BFF 服务器在 random port
const mockBffPort = 39999
let mockBff: { stop: () => void }
const fakeImageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]) // PNG magic
const requestedPaths: string[] = []

process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = TEST_DB
process.env.BFF_INTERNAL_URL = `http://127.0.0.1:${mockBffPort}`
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.PORT = '0'

const writer = createDb(TEST_DB)
const now = Date.now()
// task with openai result + has 1 image
await writer.db.insert(writer.schema.tasks).values({
  id: 'img-task-1',
  provider: 'openai-compat',
  model: 'gpt-image-2',
  status: 'completed',
  request_payload: {
    prompt: 'p',
    device_id: 'dev-img',
    input_images: ['data:image/png;base64,T1BFTkFJ'],
  } as never,
  result_payload: { data: [{ b64_json: 'AAAA' }] } as never,
  submitted_at: now,
  completed_at: now + 1000,
})
// task with gemini that has inlineData (used by input-image test)
await writer.db.insert(writer.schema.tasks).values({
  id: 'img-task-gem',
  provider: 'gemini',
  model: 'gemini-3-pro',
  status: 'completed',
  request_payload: {
    prompt: 'p',
    device_id: 'dev-img',
    input_images: ['data:image/png;base64,QkFTRTY0'],
  } as never,
  result_payload: {
    candidates: [
      { content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'QkFTRTY0' } }] } },
    ],
  } as never,
  submitted_at: now,
  completed_at: now + 1000,
})

beforeAll(() => {
  mockBff = Bun.serve({
    port: mockBffPort,
    fetch(req) {
      const url = new URL(req.url)
      requestedPaths.push(url.pathname)
      if (req.headers.get('authorization') !== 'Bearer fixture-service-credential-alpha') {
        return new Response('unauthorized', { status: 401 })
      }
      if (url.pathname.includes('/image/') || url.pathname.includes('/input-image/')) {
        return new Response(fakeImageBytes, {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': String(fakeImageBytes.length) },
        })
      }
      return new Response('not found', { status: 404 })
    },
  })
})

beforeEach(() => {
  // bun:test 会在同一进程加载多个 test 文件；其它文件会改同名 env。
  process.env.BFF_INTERNAL_URL = `http://127.0.0.1:${mockBffPort}`
  process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
  requestedPaths.length = 0
})

afterAll(async () => {
  mockBff?.stop()
  await writer.close()
})

const { app } = await import('../../../../server/app')
// Dynamic imports are required because config reads the test environment during module loading.
const { config } = await import('../../../../server/config')

async function login() {
  const res = await app.handle(
    new Request('http://localhost/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.200' },
      body: JSON.stringify({ password: 'test-pass-1234' }),
    }),
  )
  return res.headers.get('set-cookie')!.split(';')[0]!
}

describe('GET /api/tasks/:id/image', () => {
  it('未登录 → 401', async () => {
    const res = await app.handle(new Request('http://localhost/api/tasks/img-task-1/image?idx=0'))
    expect(res.status).toBe(401)
  })

  it('已知 task：反代 BFF binary 返 image bytes', async () => {
    const cookie = await login()
    const res = await app.handle(
      new Request('http://localhost/api/tasks/img-task-1/image?idx=0', { headers: { cookie } }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/png')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(bytes[0]).toBe(0x89)
    expect(bytes[1]).toBe(0x50)
    expect(requestedPaths).toEqual(['/v1/queue/requests/img-task-1/image/0'])
  })

  it('未知 task → 404', async () => {
    const cookie = await login()
    const res = await app.handle(
      new Request('http://localhost/api/tasks/nope/image?idx=0', { headers: { cookie } }),
    )
    expect(res.status).toBe(404)
  })
})

describe('GET /api/tasks/:id/input-image', () => {
  it('proxies Gemini input bytes through the authenticated BFF image channel', async () => {
    const cookie = await login()
    const res = await app.handle(
      new Request('http://localhost/api/tasks/img-task-gem/input-image?idx=0', {
        headers: { cookie },
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/png')
    expect(requestedPaths).toEqual(['/v1/queue/requests/img-task-gem/input-image/0'])
  })

  it('proxies OpenAI input bytes through the same authenticated BFF image channel', async () => {
    const cookie = await login()
    const res = await app.handle(
      new Request('http://localhost/api/tasks/img-task-1/input-image?idx=0', {
        headers: { cookie },
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/png')
    expect(requestedPaths).toEqual(['/v1/queue/requests/img-task-1/input-image/0'])
  })

  it('keeps unknown tasks hidden before proxying', async () => {
    const cookie = await login()
    const res = await app.handle(
      new Request('http://localhost/api/tasks/nope/input-image?idx=0', { headers: { cookie } }),
    )
    expect(res.status).toBe(404)
    expect(requestedPaths).toEqual([])
  })

  it('fails configuration validation when account authentication has no service credential', () => {
    delete process.env.INTERNAL_API_TOKEN
    try {
      expect(() => config.assertValid()).toThrow('Missing env: INTERNAL_API_TOKEN')
    } finally {
      process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
    }
  })
})
