import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import {
  _setPrivateBffOverlayForTesting,
  EMPTY_PRIVATE_BFF_OVERLAY,
} from '../../lib/private-overlay'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

const TEST_DB = await resetTestDatabase('bff_video_routes')

process.env.PORT = '0'
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.CORS_ALLOWED_ORIGINS = 'https://app.example'

// Dynamic import keeps environment setup ahead of configuration module evaluation.
const { app } = await import('../../app')
const { close: closeDb, db, schema } = await import('../../db/client')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { _setChannelsForTesting } = await import('../../lib/channels')
type InternalChannel = import('../../lib/channels').InternalChannel

/** ISO-BMFF 头：4 字节 box size + 'ftyp'，共 12 字节。 */
const MP4_BYTES = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
])
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const channels: InternalChannel[] = [
  {
    id: 'openai-images',
    kind: 'openai-queue',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    auth: { type: 'bearer', secretRef: 'OPENAI_API_KEY', secret: 'k' },
    allowedPaths: ['images/generations'],
    models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate'] }],
    defaults: {},
  },
  {
    id: 'grok-video',
    kind: 'openai-queue',
    label: 'Grok Imagine Video',
    baseUrl: 'https://gateway.example/v1',
    auth: { type: 'bearer', secretRef: 'GROK_API_KEY', secret: 'k' },
    allowedPaths: ['videos/generations'],
    models: [
      {
        id: 'grok-imagine-video',
        label: 'Grok Imagine Video',
        media: 'video',
        capabilities: ['generate', 'duration', 'aspect_ratio', 'resolution', 'first_frame'],
      },
    ],
    defaults: { asyncTasks: true },
  },
]

let storage: InMemoryObjectStore

beforeEach(async () => {
  storage = new InMemoryObjectStore()
  setObjectStoreForTesting(storage)
  _setChannelsForTesting(channels)
  await db.delete(schema.tasks)
  await db.delete(schema.daily_quota)
  await db.delete(schema.users)
})

afterEach(() => {
  setObjectStoreForTesting()
  _setChannelsForTesting([])
})

afterAll(async () => {
  await closeDb()
})

const TINY_PNG = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=`

async function submit(model: string, body: Record<string, unknown>) {
  const res = await app.handle(
    new Request(`http://localhost/v1/queue/openai-compat/${model}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'a cat surfing',
        device_id: 'test-device-aaaa-bbbb-cccc',
        client_request_id: crypto.randomUUID(),
        ...body,
      }),
    }),
  )
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

async function insertCompletedVideo(
  id: string,
  mime = 'video/mp4',
  overrides: Partial<typeof schema.tasks.$inferInsert> = {},
): Promise<void> {
  const bytes = mime === 'video/mp4' ? MP4_BYTES : PNG_BYTES
  await storage.write(`${id}/out/0`, bytes, mime)
  const now = Date.now()
  await db.insert(schema.tasks).values({
    id,
    provider: 'openai-compat',
    model: 'grok-imagine-video',
    status: 'completed',
    request_payload: { prompt: 'a cat surfing', device_id: 'test-device-aaaa-bbbb-cccc' },
    result_payload: {
      data: [{ object: `${id}/out/0`, mime, duration_seconds: 5 }],
    },
    submitted_at: now,
    completed_at: now,
    ...overrides,
  })
}

async function storedVideo(requestId: unknown): Promise<Record<string, unknown> | undefined> {
  const [task] = await db
    .select({ request_payload: schema.tasks.request_payload })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, String(requestId)))
  return (task?.request_payload as { video?: Record<string, unknown> } | undefined)?.video
}

const OTHER_USER = 'user-other'

async function insertOtherUser(): Promise<void> {
  const now = Date.now()
  await db.insert(schema.users).values({
    id: OTHER_USER,
    username: 'other',
    password_hash: 'x',
    created_at: now,
    updated_at: now,
  })
}

function extendBody(overrides: Record<string, unknown> = {}) {
  return {
    video: {
      duration_seconds: 3,
      aspect_ratio: '16:9',
      resolution: '720p',
      mode: 'extend',
      source_task_id: 'src-video',
      source_output_index: 0,
      ...overrides,
    },
  }
}

describe('video submit validation', () => {
  it('queues a valid video request', async () => {
    const { status, json } = await submit('grok-imagine-video', {
      video: { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' },
    })

    expect(status).toBe(200)
    expect(json).toMatchObject({ status: 'queued' })
  })

  it('rejects a last frame on a model that only supports a first frame', async () => {
    const { status, json } = await submit('grok-imagine-video', {
      input_images: [TINY_PNG],
      video: {
        duration_seconds: 5,
        aspect_ratio: '16:9',
        resolution: '720p',
        last_frame_index: 0,
      },
    })

    expect(status).toBe(400)
    expect(json.error).toBe('invalid_video_request')
    expect(String(json.message)).toContain('尾帧')
  })

  it('rejects a resolution the model does not offer', async () => {
    const { status, json } = await submit('grok-imagine-video', {
      video: { duration_seconds: 5, aspect_ratio: '16:9', resolution: '2k' },
    })

    expect(status).toBe(400)
    expect(String(json.message)).toContain('清晰度')
  })

  it('rejects video parameters sent to an image model', async () => {
    const { status, json } = await submit('gpt-image-2', {
      video: { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' },
    })

    expect(status).toBe(400)
    expect(json.error).toBe('video_not_supported')
  })

  it('rejects a video model submitted without video parameters', async () => {
    const { status, json } = await submit('grok-imagine-video', {})

    expect(status).toBe(400)
    expect(json.error).toBe('video_params_required')
  })
})

describe('video source validation', () => {
  it('queues an extension and stores only the source reference', async () => {
    await insertCompletedVideo('src-video')

    const { status, json } = await submit('grok-imagine-video', extendBody())

    expect(status).toBe(200)
    expect(await storedVideo(json.request_id)).toEqual({
      duration_seconds: 3,
      aspect_ratio: '16:9',
      resolution: '720p',
      mode: 'extend',
      source_task_id: 'src-video',
      source_output_index: 0,
      source_video: { object: 'src-video/out/0', mime: 'video/mp4' },
    })
  })

  it('rejects a source task that does not exist', async () => {
    const { status, json } = await submit('grok-imagine-video', extendBody())

    expect(status).toBe(400)
    expect(json.error).toBe('invalid_video_source')
    expect(String(json.message)).toContain('源视频不存在')
  })

  it('rejects a source task owned by somebody else', async () => {
    await insertOtherUser()
    await insertCompletedVideo('src-video', 'video/mp4', { user_id: OTHER_USER })

    const { status, json } = await submit('grok-imagine-video', extendBody())

    expect(status).toBe(400)
    expect(String(json.message)).toContain('源视频不存在')
  })

  it('rejects a source task that has not completed', async () => {
    await insertCompletedVideo('src-video', 'video/mp4', { status: 'in_progress' })

    const { status, json } = await submit('grok-imagine-video', extendBody())

    expect(status).toBe(400)
    expect(String(json.message)).toContain('还没生成完成')
  })

  it('rejects a source output that is an image', async () => {
    await insertCompletedVideo('src-video', 'image/png')

    const { status, json } = await submit('grok-imagine-video', extendBody())

    expect(status).toBe(400)
    expect(String(json.message)).toContain('不是视频')
  })

  it('rejects a source output index the task does not have', async () => {
    await insertCompletedVideo('src-video')

    const { status, json } = await submit(
      'grok-imagine-video',
      extendBody({ source_output_index: 3 }),
    )

    expect(status).toBe(400)
    expect(String(json.message)).toContain('不是视频')
  })

  it('drops a client supplied source reference on a plain generation', async () => {
    const { status, json } = await submit('grok-imagine-video', {
      video: {
        duration_seconds: 5,
        aspect_ratio: '16:9',
        resolution: '720p',
        source_video: { object: 'someone-else/out/0', mime: 'video/mp4' },
      },
    })

    expect(status).toBe(200)
    expect(await storedVideo(json.request_id)).not.toHaveProperty('source_video')
  })
})

describe('video output endpoint', () => {
  it('serves the whole file with a seekable header when no range is asked for', async () => {
    await insertCompletedVideo('video-full')

    const res = await app.handle(
      new Request('http://localhost/v1/queue/requests/video-full/output/0'),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(MP4_BYTES)
  })

  it('answers a byte range with 206 and the matching slice', async () => {
    await insertCompletedVideo('video-range')

    const res = await app.handle(
      new Request('http://localhost/v1/queue/requests/video-range/output/0', {
        headers: { range: 'bytes=0-3' },
      }),
    )

    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-3/12')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(MP4_BYTES.slice(0, 4))
  })

  it('clamps an open ended range to the end of the file', async () => {
    await insertCompletedVideo('video-open-range')

    const res = await app.handle(
      new Request('http://localhost/v1/queue/requests/video-open-range/output/0', {
        headers: { range: 'bytes=8-' },
      }),
    )

    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 8-11/12')
  })

  it('rejects a range that starts past the end of the file', async () => {
    await insertCompletedVideo('video-bad-range')

    const res = await app.handle(
      new Request('http://localhost/v1/queue/requests/video-bad-range/output/0', {
        headers: { range: 'bytes=99-' },
      }),
    )

    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */12')
  })

  it('sends credentialed CORS headers for the requesting origin', async () => {
    await insertCompletedVideo('video-cors')

    const res = await app.handle(
      new Request('http://localhost/v1/queue/requests/video-cors/output/0', {
        headers: { origin: 'https://app.example' },
      }),
    )

    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example')
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
  })

  it('keeps the legacy image path pointing at the same bytes', async () => {
    await insertCompletedVideo('video-alias')

    const res = await app.handle(
      new Request('http://localhost/v1/queue/requests/video-alias/image/0', {
        headers: { range: 'bytes=0-3' },
      }),
    )

    expect(res.status).toBe(206)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(MP4_BYTES.slice(0, 4))
  })

  it('leaves image outputs unseekable', async () => {
    await insertCompletedVideo('image-output', 'image/png')

    const res = await app.handle(
      new Request('http://localhost/v1/queue/requests/image-output/output/0', {
        headers: { range: 'bytes=0-3' },
      }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('accept-ranges')).toBeNull()
  })

  it('reports the duration in the result metadata', async () => {
    await insertCompletedVideo('video-meta')

    const res = await app.handle(new Request('http://localhost/v1/queue/requests/video-meta'))

    expect(await res.json()).toMatchObject({
      status: 'completed',
      images: [{ index: 0, mime: 'video/mp4', duration_seconds: 5 }],
    })
  })
})
