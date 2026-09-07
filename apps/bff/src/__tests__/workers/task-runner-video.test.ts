import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import {
  _setPrivateBffOverlayForTesting,
  EMPTY_PRIVATE_BFF_OVERLAY,
} from '../../lib/private-overlay'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import {
  jsonResponse as json,
  type RecordingUpstream,
  recordingUpstreamFetch,
  stubGlobalFetch,
} from '../helpers/upstreamStubs'

process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test-key'
const databaseUrl = await resetTestDatabase('bff_task_runner_video')
process.env.DATABASE_URL = databaseUrl
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)
process.env.PORT = '0'

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { close: closeDb, db, schema } = await import('../../db/client')
const { runTask } = await import('../../workers/task-runner')
const { setAsyncPollBackoffForTesting, setUpstreamFetchForTesting } = await import(
  '../../lib/upstream'
)
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { _setChannelsForTesting } = await import('../../lib/channels')
type InternalChannel = import('../../lib/channels').InternalChannel

const GROK_BASE = 'https://gateway.example/v1'
const AGNES_BASE = 'https://apihub.agnes-ai.com/v1'
const RESULT_URL = 'https://cdn.agnes-ai.com/videos/a.mp4'
/** ISO-BMFF 头：4 字节 box size + 'ftyp'。 */
const MP4_BYTES = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
])

const videoChannels: InternalChannel[] = [
  {
    id: 'grok-video',
    kind: 'openai-queue',
    label: 'Grok Imagine Video',
    baseUrl: GROK_BASE,
    auth: { type: 'bearer', secretRef: 'GROK_API_KEY', secret: 'grok-test-key' },
    allowedPaths: ['videos/generations', 'videos'],
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
  {
    id: 'agnes-video',
    kind: 'openai-queue',
    label: 'Agnes AI Video',
    baseUrl: AGNES_BASE,
    auth: { type: 'bearer', secretRef: 'AGNES_API_KEY', secret: 'agnes-test-key' },
    allowedPaths: ['videos', 'agnesapi'],
    models: [
      {
        id: 'agnes-video-2.5-flash',
        label: 'Agnes Video 2.5 Flash',
        media: 'video',
        capabilities: ['generate', 'duration', 'aspect_ratio', 'resolution', 'first_frame'],
      },
    ],
    defaults: { asyncTasks: true },
  },
]

let upstream: RecordingUpstream
let restoreFetch: () => void
let storage: InMemoryObjectStore

beforeEach(async () => {
  storage = new InMemoryObjectStore()
  setObjectStoreForTesting(storage)
  await db.delete(schema.tasks)
  _setChannelsForTesting(videoChannels)
  setAsyncPollBackoffForTesting([1])
  upstream = recordingUpstreamFetch()
  setUpstreamFetchForTesting(upstream.fetch)
  // 归档回源取 Agnes 结果地址走 globalThis.fetch，不是上游注入点。
  restoreFetch = stubGlobalFetch(() => new Response(MP4_BYTES, { status: 200 }))
})

afterEach(() => {
  setUpstreamFetchForTesting()
  setAsyncPollBackoffForTesting()
  setObjectStoreForTesting()
  _setChannelsForTesting([])
  restoreFetch()
  mock.restore()
})

afterAll(async () => {
  await closeDb()
})

async function readTask(id: string) {
  const [row] = await db
    .select({
      status: schema.tasks.status,
      attempt: schema.tasks.attempt_count,
      errorType: schema.tasks.error_type,
      errorMessage: schema.tasks.error_message,
      invocations: schema.tasks.upstream_invocation_count,
      taskIds: schema.tasks.upstream_task_ids,
      result: schema.tasks.result_payload,
    })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, id))
  return row
}

async function insertVideoTask(
  id: string,
  model: string,
  overrides: Partial<typeof schema.tasks.$inferInsert> = {},
): Promise<void> {
  await db.insert(schema.tasks).values({
    id,
    provider: 'openai-compat',
    model,
    status: 'queued',
    request_payload: {
      prompt: 'a cat surfing',
      video: { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' },
    },
    submitted_at: 1,
    ...overrides,
  })
}

describe('Grok video task', () => {
  it('runs create, poll and content fetch through to an archived mp4', async () => {
    let polls = 0
    upstream.handler = (url) => {
      if (url.endsWith('/videos/generations')) return json({ request_id: 'req_1' })
      if (url.endsWith('/videos/req_1')) {
        return ++polls === 1
          ? json({ status: 'pending', progress: 1 })
          : json({
              status: 'done',
              progress: 100,
              video: { duration: 5, url: '/v1/videos/req_1/content' },
            })
      }
      return new Response(MP4_BYTES, { status: 200 })
    }
    await insertVideoTask('grok-video-task', 'grok-imagine-video')

    await runTask('grok-video-task')

    const row = await readTask('grok-video-task')
    expect(row).toMatchObject({ status: 'completed', invocations: 1, taskIds: ['req_1'] })
    expect(row?.result).toMatchObject({
      data: [{ object: 'grok-video-task/out/0', mime: 'video/mp4', duration_seconds: 5 }],
    })
    expect(await storage.read('grok-video-task/out/0')).toEqual(MP4_BYTES)
  })
})

describe('Agnes video task', () => {
  it('archives the result address as mp4 bytes', async () => {
    let polls = 0
    upstream.handler = (url) => {
      if (url.endsWith('/videos')) return json({ video_id: 'task_1', status: 'queued' })
      return ++polls === 1
        ? json({ status: 'in_progress' })
        : json({ status: 'completed', url: RESULT_URL })
    }
    await insertVideoTask('agnes-video-task', 'agnes-video-2.5-flash')

    await runTask('agnes-video-task')

    const row = await readTask('agnes-video-task')
    expect(row).toMatchObject({ status: 'completed', taskIds: ['task_1'] })
    expect(row?.result).toMatchObject({
      data: [
        {
          object: 'agnes-video-task/out/0',
          mime: 'video/mp4',
          duration_seconds: 5,
          source_url: RESULT_URL,
        },
      ],
    })
    expect(await storage.read('agnes-video-task/out/0')).toEqual(MP4_BYTES)
  })

  it('writes a terminal failure when the upstream task reports failed', async () => {
    upstream.handler = (url) =>
      url.endsWith('/videos')
        ? json({ video_id: 'task_2' })
        : json({ status: 'failed', error: { message: 'generation failed' } })
    await insertVideoTask('agnes-video-failed', 'agnes-video-2.5-flash')

    await runTask('agnes-video-failed')

    expect(await readTask('agnes-video-failed')).toMatchObject({
      status: 'failed',
      errorType: 'upstream_error',
      errorMessage: 'generation failed',
      attempt: 0,
    })
  })
})

describe('restart recovery', () => {
  it('resumes polling from the stored id instead of creating a second upstream task', async () => {
    upstream.handler = (url) =>
      url.endsWith('/videos/req_7')
        ? json({ status: 'done', video: { duration: 5, url: '/v1/videos/req_7/content' } })
        : new Response(MP4_BYTES, { status: 200 })
    await insertVideoTask('grok-video-resume', 'grok-imagine-video', {
      upstream_task_ids: ['req_7'],
      upstream_submitted_at: Date.now(),
      upstream_invocation_count: 1,
    })

    await runTask('grok-video-resume')

    expect(await readTask('grok-video-resume')).toMatchObject({
      status: 'completed',
      invocations: 1,
      taskIds: ['req_7'],
    })
    expect(upstream.calls).toEqual([
      `${GROK_BASE}/videos/req_7`,
      `${GROK_BASE}/videos/req_7/content`,
    ])
  })
})
