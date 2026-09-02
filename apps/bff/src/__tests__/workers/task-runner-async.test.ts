import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import {
  _setPrivateBffOverlayForTesting,
  EMPTY_PRIVATE_BFF_OVERLAY,
} from '../../lib/private-overlay'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { stubGlobalFetch } from '../helpers/upstreamStubs'

process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test-key'
process.env.UPSTREAM_ASYNC_IMAGE_TASKS = 'true'
const databaseUrl = await resetTestDatabase('bff_task_runner_async')
process.env.DATABASE_URL = databaseUrl
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)
process.env.PORT = '0'

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { close: closeDb, db, schema } = await import('../../db/client')
const { runTask } = await import('../../workers/task-runner')
const { recoverTasksByIds } = await import('../../db/maintenance')
const { setUpstreamFetchForTesting } = await import('../../lib/upstream')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
type TestFetch = NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>

const RESULT_URL = 'https://bucket.example/a.png'
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

let calls: string[] = []
let handler: (url: string) => Response
let restoreFetch: () => void

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function submitThenComplete(url: string): Response {
  return url.endsWith('/async')
    ? json({ task_id: 'imgtask_1', status: 'processing' }, 202)
    : json({ status: 'completed', result: { data: [{ url: RESULT_URL }] } })
}

beforeEach(async () => {
  setObjectStoreForTesting(new InMemoryObjectStore())
  await db.delete(schema.tasks)
  calls = []
  handler = submitThenComplete
  setUpstreamFetchForTesting((async (input: Parameters<TestFetch>[0]) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push(url)
    return handler(url)
  }) as unknown as TestFetch)
  // 归档回源取结果 URL 走 globalThis.fetch，不是上游注入点。
  restoreFetch = stubGlobalFetch(() => new Response(PNG_BYTES, { status: 200 }))
})

afterEach(() => {
  setUpstreamFetchForTesting()
  setObjectStoreForTesting()
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
      invocations: schema.tasks.upstream_invocation_count,
      taskIds: schema.tasks.upstream_task_ids,
      submittedAt: schema.tasks.upstream_submitted_at,
    })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, id))
  return row
}

async function insertTask(
  id: string,
  overrides: Partial<typeof schema.tasks.$inferInsert> = {},
): Promise<void> {
  await db.insert(schema.tasks).values({
    id,
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status: 'queued',
    request_payload: { prompt: id },
    submitted_at: 1,
    ...overrides,
  })
}

describe('async submit phase', () => {
  it('stores the upstream task id and counts exactly one invocation', async () => {
    await insertTask('async-ok')

    await runTask('async-ok')

    expect(await readTask('async-ok')).toMatchObject({
      status: 'completed',
      invocations: 1,
      taskIds: ['imgtask_1'],
    })
    expect((await readTask('async-ok'))?.submittedAt).toBeGreaterThan(0)
  })

  it('leaves no task id behind when the submit never reached the upstream', async () => {
    handler = () => {
      throw new Error('socket hang up')
    }
    await insertTask('async-transport')

    await runTask('async-transport')

    // 提交结果未知 → 不自动重试，否则无幂等键的上游会被重复计费。
    expect(await readTask('async-transport')).toMatchObject({
      status: 'failed',
      errorType: 'upstream_result_unknown',
      attempt: 0,
      taskIds: null,
    })
  })

  it('keeps a terminal upstream task failure terminal instead of resubmitting', async () => {
    handler = (url) =>
      url.endsWith('/async')
        ? json({ task_id: 'imgtask_1' }, 202)
        : json({ status: 'failed', http_status: 400, error: { message: 'blocked' } })
    await insertTask('async-blocked')

    await runTask('async-blocked')

    expect(await readTask('async-blocked')).toMatchObject({
      status: 'failed',
      errorType: 'upstream_error',
      invocations: 1,
    })
    expect(calls.filter((url) => url.endsWith('/async'))).toHaveLength(1)
  })

  it('clears the stored id when a retryable upstream failure sends the task back to the queue', async () => {
    handler = (url) =>
      url.endsWith('/async')
        ? json({ task_id: 'imgtask_1' }, 202)
        : json({ status: 'failed', http_status: 500, error: { message: 'upstream exploded' } })
    await insertTask('async-retryable')

    await runTask('async-retryable')

    // 留着旧 id，下一次尝试就会去轮一个已经终态失败的任务，永远出不来。
    expect(await readTask('async-retryable')).toMatchObject({
      status: 'queued',
      attempt: 1,
      taskIds: null,
      submittedAt: null,
    })
  })
})

describe('restart recovery', () => {
  it('resumes polling from the stored id without resubmitting or recharging', async () => {
    await insertTask('async-resume', {
      status: 'in_progress',
      started_at: 1,
      upstream_task_ids: ['imgtask_7'],
      upstream_submitted_at: Date.now(),
      upstream_invocation_count: 1,
    })

    expect(await recoverTasksByIds(['async-resume'])).toEqual({
      requeued: 0,
      failed: 0,
      resumedPolling: 1,
    })
    expect(await readTask('async-resume')).toMatchObject({
      status: 'queued',
      attempt: 0,
      taskIds: ['imgtask_7'],
    })

    await runTask('async-resume')

    expect(await readTask('async-resume')).toMatchObject({
      status: 'completed',
      attempt: 0,
      invocations: 1,
    })
    expect(calls).toEqual(['http://localhost:9999/v1/images/tasks/imgtask_7'])
  })

  it('fails a resumed task whose original submit is already past the polling deadline', async () => {
    await insertTask('async-expired', {
      status: 'in_progress',
      started_at: 1,
      upstream_task_ids: ['imgtask_8'],
      upstream_submitted_at: Date.now() - QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS - 1,
      upstream_invocation_count: 1,
    })

    await recoverTasksByIds(['async-expired'])
    await runTask('async-expired')

    expect(await readTask('async-expired')).toMatchObject({
      status: 'failed',
      errorType: 'upstream_result_unknown',
    })
    expect(calls).toEqual([])
  })

  it('still requeues a task that never got a task id through the retry budget', async () => {
    await insertTask('async-unsubmitted', { status: 'in_progress', started_at: 1 })

    expect(await recoverTasksByIds(['async-unsubmitted'])).toEqual({
      requeued: 1,
      failed: 0,
      resumedPolling: 0,
    })
    expect(await readTask('async-unsubmitted')).toMatchObject({ status: 'queued', attempt: 1 })
  })
})
