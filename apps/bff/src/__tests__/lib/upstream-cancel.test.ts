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
const { cancelTasks } = await import('../../db/task-transitions')
const { cancelUpstreamOfCancelledTasks } = await import('../../lib/upstream-cancel')
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
// 提交请求在上游「建起任务」之后、响应回到 worker 之前停住，用来复现取消先落库、上游 id 后到。
let holdPost: Promise<void> | null = null

beforeEach(async () => {
  await db.delete(schema.tasks)
  calls = []
  holdPost = null
  setObjectStoreForTesting(new InMemoryObjectStore())
  setAsyncPollBackoffForTesting([5])
  _setChannelsForTesting([arkVideoChannel])
  setUpstreamFetchForTesting((async (input: Parameters<TestFetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method })
    if (method === 'POST' && url === ARK_TASKS) {
      if (holdPost) await holdPost
      return json({ id: 'task_ark_1' })
    }
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

const arkTask = (
  id: string,
  extra: Partial<typeof schema.tasks.$inferInsert> = {},
): typeof schema.tasks.$inferInsert => ({
  id,
  provider: 'openai-compat',
  model: ARK_MODEL,
  status: 'queued',
  request_payload: {
    prompt: 'a cat',
    video: { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' },
  },
  submitted_at: 1,
  ...extra,
})
const deletes = () => calls.filter((call) => call.method === 'DELETE')

describe('取消后尽力叫停上游（BUG-32）', () => {
  it('取消一条已拿到方舟任务 id、正排队等续轮询的任务：不靠 worker 运行中登记，直接发 DELETE', async () => {
    // 没有任何 worker 在跑它：上游 id 已落库，任务回到 queued 等下一次轮询。
    await db
      .insert(schema.tasks)
      .values(
        arkTask('ark-waiting', { upstream_task_ids: ['task_ark_1'], upstream_submitted_at: 1 }),
      )

    const cancelled = await cancelTasks(eq(schema.tasks.id, 'ark-waiting'))
    await cancelUpstreamOfCancelledTasks(cancelled.map((row) => row.id))

    expect((await statusOf('ark-waiting'))?.status).toBe('cancelled')
    expect(deletes()).toEqual([{ url: `${ARK_TASKS}/task_ark_1`, method: 'DELETE' }])
  })

  it('转去核查（reconciling）的任务不去取消上游：上游任务还要接着核查', async () => {
    await db.insert(schema.tasks).values(
      arkTask('ark-reconcile', {
        status: 'reconciling',
        reconciliation_required: true,
        upstream_task_ids: ['task_ark_1'],
        upstream_submitted_at: 1,
        upstream_invocation_count: 1,
      }),
    )

    await cancelUpstreamOfCancelledTasks(['ark-reconcile'])

    expect(deletes()).toEqual([])
  })

  it('取消先落库、上游 id 后到：写入 id 被栅栏挡下时由 worker 补发 DELETE', async () => {
    let release!: () => void
    holdPost = new Promise((resolve) => {
      release = resolve
    })
    await db.insert(schema.tasks).values(arkTask('ark-late'))

    const scheduler = new TaskScheduler({ pollIntervalMs: 10_000 })
    scheduler.start()
    try {
      await waitFor(() => calls.some((call) => call.method === 'POST'))
      // 取消入口此刻读不到上游 id，只能退款，叫停不了上游。
      const cancelled = await cancelTasks(eq(schema.tasks.id, 'ark-late'))
      await cancelUpstreamOfCancelledTasks(cancelled.map((row) => row.id))
      expect(deletes()).toEqual([])

      release()
      await waitFor(() => deletes().length > 0)
      await waitFor(() => scheduler.activeCount() === 0)
    } finally {
      scheduler.stop()
    }

    expect(deletes()).toEqual([{ url: `${ARK_TASKS}/task_ark_1`, method: 'DELETE' }])
    expect((await statusOf('ark-late'))?.status).toBe('cancelled')
  })
})
