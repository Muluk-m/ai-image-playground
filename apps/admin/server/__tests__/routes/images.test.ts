import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Buffer } from 'node:buffer'
import { unlinkSync } from 'node:fs'

const TEST_DB = './artifacts/test-admin-images.sqlite'
try {
  unlinkSync(TEST_DB)
  unlinkSync(`${TEST_DB}-wal`)
  unlinkSync(`${TEST_DB}-shm`)
} catch {}

// 启一个 mock BFF 服务器在 random port
const mockBffPort = 39999
let mockBff: { stop: () => void }
const fakeImageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]) // PNG magic

process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = TEST_DB
process.env.BFF_INTERNAL_URL = `http://localhost:${mockBffPort}`
process.env.PORT = '0'

const { runMigrations, createDb } = await import('@image-playground/db')
runMigrations(TEST_DB)
const writer = createDb(TEST_DB)
const now = Date.now()
// task with openai result + has 1 image
writer.db
  .insert(writer.schema.tasks)
  .values({
    id: 'img-task-1',
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status: 'completed',
    request_payload: { prompt: 'p', device_id: 'dev-img' } as never,
    result_payload: { data: [{ b64_json: 'AAAA' }] } as never,
    submitted_at: now,
    completed_at: now + 1000,
  })
  .run()
// legacy tasks keep data URLs directly in request_payload.input_images
writer.db
  .insert(writer.schema.tasks)
  .values([
    {
      id: 'img-task-gem-legacy',
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
    },
    {
      id: 'img-task-openai-legacy',
      provider: 'openai-compat',
      model: 'gpt-image-2',
      status: 'completed',
      request_payload: {
        prompt: 'p',
        device_id: 'dev-img',
        input_images: ['data:image/jpeg;base64,T1BFTkFJ'],
      } as never,
      submitted_at: now,
      completed_at: now + 1000,
    },
  ])
  .run()
// externalized tasks keep refs in request_payload and bytes in task_blobs
writer.db
  .insert(writer.schema.tasks)
  .values([
    {
      id: 'img-task-openai-blob',
      provider: 'openai-compat',
      model: 'gpt-image-2',
      status: 'completed',
      request_payload: {
        prompt: 'p',
        device_id: 'dev-img',
        input_images: [{ $blob: 0 }],
      } as never,
      submitted_at: now,
      completed_at: now + 1000,
    },
    {
      id: 'img-task-gem-blob',
      provider: 'gemini',
      model: 'gemini-3-pro',
      status: 'completed',
      request_payload: {
        prompt: 'p',
        device_id: 'dev-img',
        input_images: [{ $blob: 7 }],
      } as never,
      submitted_at: now,
      completed_at: now + 1000,
    },
  ])
  .run()
writer.db
  .insert(writer.schema.task_blobs)
  .values([
    {
      id: 'blob-openai-input-0',
      task_id: 'img-task-openai-blob',
      kind: 'input',
      idx: 0,
      mime: 'image/webp',
      data: Buffer.from([0x52, 0x49, 0x46, 0x46]),
      created_at: now,
    },
    {
      id: 'blob-gemini-input-7',
      task_id: 'img-task-gem-blob',
      kind: 'input',
      idx: 7,
      mime: 'image/webp',
      data: Buffer.from([0x57, 0x45, 0x42, 0x50]),
      created_at: now,
    },
  ])
  .run()

beforeAll(() => {
  // 极简 mock BFF：任何 /v1/queue/.../binary 都返 fake bytes
  mockBff = Bun.serve({
    port: mockBffPort,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.includes('/binary') || url.pathname.includes('/image/')) {
        return new Response(fakeImageBytes, {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': String(fakeImageBytes.length) },
        })
      }
      return new Response('not found', { status: 404 })
    },
  })
})

afterAll(() => {
  mockBff?.stop()
})

const { app } = await import('../../app')

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
  it('未登录 → 401', async () => {
    const res = await app.handle(
      new Request('http://localhost/api/tasks/img-task-openai-blob/input-image?idx=0'),
    )
    expect(res.status).toBe(401)
  })

  it('serves an externalized OpenAI input blob', async () => {
    const cookie = await login()
    const res = await app.handle(
      new Request('http://localhost/api/tasks/img-task-openai-blob/input-image?idx=0', {
        headers: { cookie },
      }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/webp')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([0x52, 0x49, 0x46, 0x46]),
    )
  })

  it('serves an externalized Gemini input blob using the ref index', async () => {
    const cookie = await login()
    const res = await app.handle(
      new Request('http://localhost/api/tasks/img-task-gem-blob/input-image?idx=0', {
        headers: { cookie },
      }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/webp')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([0x57, 0x45, 0x42, 0x50]),
    )
  })

  it('serves a legacy Gemini data URL', async () => {
    const cookie = await login()
    const res = await app.handle(
      new Request('http://localhost/api/tasks/img-task-gem-legacy/input-image?idx=0', {
        headers: { cookie },
      }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/png')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('BASE64')
  })

  it('serves a legacy OpenAI data URL', async () => {
    const cookie = await login()
    const res = await app.handle(
      new Request('http://localhost/api/tasks/img-task-openai-legacy/input-image?idx=0', {
        headers: { cookie },
      }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/jpeg')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('OPENAI')
  })

  it('missing archive → 422 + input_image_not_archived', async () => {
    const cookie = await login()
    const res = await app.handle(
      new Request('http://localhost/api/tasks/img-task-1/input-image?idx=0', {
        headers: { cookie },
      }),
    )
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error_code: string }
    expect(body.error_code).toBe('input_image_not_archived')
  })

  it('未知 task → 404 + task_not_found', async () => {
    const cookie = await login()
    const res = await app.handle(
      new Request('http://localhost/api/tasks/nope/input-image?idx=0', { headers: { cookie } }),
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error_code: string }
    expect(body.error_code).toBe('task_not_found')
  })
})
