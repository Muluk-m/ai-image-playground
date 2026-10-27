import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import {
  _setPrivateBffOverlayForTesting,
  EMPTY_PRIVATE_BFF_OVERLAY,
} from '../../lib/private-overlay'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { jsonResponse as json, waitFor } from '../helpers/upstreamStubs'

process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test-key'
const databaseUrl = await resetTestDatabase('bff_upstream_cancel')
process.env.DATABASE_URL = databaseUrl
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)
process.env.PORT = '0'

const { close: closeDb, db, schema } = await import('../../db/client')
const { TaskScheduler } = await import('../../workers/task-scheduler')
const { setUpstreamFetchForTesting, setAsyncPollBackoffForTesting } = await import(
  '../../lib/upstream'
)
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { _setChannelsForTesting } = await import('../../lib/channels')
type InternalChannel = import('../../lib/channels').InternalChannel
type TestFetch = NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>

const ARK_BASE = 'https://ark.example/api/v3'
const ARK_TASKS = `${ARK_BASE}/contents/generations/tasks`
const ARK_MODEL = 'doubao-seedance-2-0-mini-260615'

const arkVideoChannel: InternalChannel = {
  id: 'ark-video',
  kind: 'openai-queue',
  label: 'Seedance Video',
  baseUrl: ARK_BASE,
  auth: { type: 'bearer', secretRef: 'ARK_API_KEY', secret: 'ark-test-key' },
  allowedPaths: ['contents/generations/tasks'],
  models: [
    {
      id: ARK_MODEL,
      label: 'Seedance 2.0 Mini',
      media: 'video',
      capabilities: ['generate', 'duration', 'aspect_ratio', 'resolution'],
    },
  ],
  defaults: { timeout: 600, asyncTasks: true },
}

type Call = { url: string; method: string }
let calls: Call[] = []

beforeEach(async () => {
  await db.delete(schema.tasks)
  calls = []
  setObjectStoreForTesting(new InMemoryObjectStore())
  setAsyncPollBackoffForTesting([5])
  _setChannelsForTesting([arkVideoChannel])
  setUpstreamFetchForTesting((async (input: Parameters<TestFetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method })
    if (method === 'POST' && url === ARK_TASKS) return json({ id: 'task_ark_1' })
    if (method === 'DELETE') return json({})
    return json({ id: 'task_ark_1', status: 'queued' })
  }) as unknown as TestFetch)
})

afterEach(() => {
  setUpstreamFetchForTesting()
  setAsyncPollBackoffForTesting()
  setObjectStoreForTesting()
  _setChannelsForTesting([])
})

afterAll(async () => {
  await closeDb()
})

async function statusOf(id: string) {
  const [row] = await db
    .select({ status: schema.tasks.status, upstream: schema.tasks.upstream_task_ids })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, id))
  return row
}

describe('取消后尽力叫停上游（BUG-32）', () => {
  it('用户取消一条在方舟排队的视频任务时，worker 向方舟发 DELETE', async () => {
    await db.insert(schema.tasks).values({
      id: 'ark-cancel',
      provider: 'openai-compat',
      model: ARK_MODEL,
      status: 'queued',
      request_payload: {
        prompt: 'a cat',
        video: { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' },
      },
      submitted_at: 1,
    })

    const scheduler = new TaskScheduler({ pollIntervalMs: 10_000 })
    scheduler.start()
    try {
      await waitFor(async () => (await statusOf('ark-cancel'))?.upstream?.length === 1)

      await db
        .update(schema.tasks)
        .set({ status: 'cancelled', completed_at: Date.now() })
        .where(eq(schema.tasks.id, 'ark-cancel'))
      await scheduler.tick()
      await waitFor(() => calls.some((call) => call.method === 'DELETE'))
      await waitFor(() => scheduler.activeCount() === 0)
    } finally {
      scheduler.stop()
    }

    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([
      { url: `${ARK_TASKS}/task_ark_1`, method: 'DELETE' },
    ])
    expect((await statusOf('ark-cancel'))?.status).toBe('cancelled')
  })

  it('库里转去核查（reconciling）而中断执行时不去取消上游：上游任务还要接着核查', async () => {
    await db.insert(schema.tasks).values({
      id: 'ark-reconcile',
      provider: 'openai-compat',
      model: ARK_MODEL,
      status: 'queued',
      request_payload: {
        prompt: 'a cat',
        video: { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' },
      },
      submitted_at: 1,
    })

    const scheduler = new TaskScheduler({ pollIntervalMs: 10_000 })
    scheduler.start()
    try {
      await waitFor(async () => (await statusOf('ark-reconcile'))?.upstream?.length === 1)
      await db
        .update(schema.tasks)
        .set({ status: 'reconciling', reconciliation_required: true })
        .where(eq(schema.tasks.id, 'ark-reconcile'))
      await scheduler.tick()
      await waitFor(() => scheduler.activeCount() === 0)
      await Bun.sleep(50)
    } finally {
      scheduler.stop()
    }

    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
  })
})
