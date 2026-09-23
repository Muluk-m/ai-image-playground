import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { extractMeta } from '../../lib/extractImages'
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
const { setAsyncPollBackoffForTesting } = await import('../../lib/upstream')

const RESULT_URL = 'https://bucket.example/a.png'
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

let upstream: RecordingUpstream
let restoreFetch: () => void

function submitThenComplete(url: string): Response {
  return url.endsWith('/async')
    ? json({ task_id: 'imgtask_1', status: 'processing' }, 202)
    : json({ status: 'completed', result: { data: [{ url: RESULT_URL }] } })
}

beforeEach(async () => {
  setObjectStoreForTesting(new InMemoryObjectStore())
  await db.delete(schema.tasks)
  upstream = recordingUpstreamFetch()
  upstream.handler = submitThenComplete
  setUpstreamFetchForTesting(upstream.fetch)
  // 归档回源取结果 URL 走 globalThis.fetch，不是上游注入点。
  restoreFetch = stubGlobalFetch(() => new Response(PNG_BYTES, { status: 200 }))
})

afterEach(() => {
  setUpstreamFetchForTesting()
  setAsyncPollBackoffForTesting()
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

    const row = await readTask('async-ok')
    expect(row).toMatchObject({ status: 'completed', invocations: 1, taskIds: ['imgtask_1'] })
    expect(row?.submittedAt).toBeGreaterThan(0)
  })

  it('archives two Flare outputs when the gateway returns one image per invocation', async () => {
    let submits = 0
    upstream.handler = (url) =>
      url.endsWith('/async')
        ? json({ task_id: `imgtask_${++submits}` }, 202)
        : json({
            status: 'completed',
            result: { data: [{ url: `${RESULT_URL}?task=${url.split('/').at(-1)}` }] },
          })
    await insertTask('flare-multi', {
      model: 'gpt-image-2.5-flare',
      request_payload: { prompt: 'two blue circle variants', n: 2 },
    })

    await runTask('flare-multi')

    const row = await readTask('flare-multi')
    expect(row).toMatchObject({ status: 'completed', invocations: 2 })
    // 两次提交是并发发出去的，谁先回来落哪一位由网络决定：这一条要钉的是「两个上游任务号都记下了」，
    // 不是它们的先后。钉顺序会让这条用例在 CI 上随机变红。
    expect([...(row?.taskIds ?? [])].sort()).toEqual(['imgtask_1', 'imgtask_2'])
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, 'flare-multi'))
    expect(extractMeta('openai-compat', task?.result_payload).images).toHaveLength(2)
  })

  it('leaves no task id behind when the submit never reached the upstream', async () => {
    upstream.handler = () => {
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
    upstream.handler = (url) =>
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
    expect(upstream.calls.filter((url) => url.endsWith('/async'))).toHaveLength(1)
  })

  it('把上游的内容安全拒绝单独记成 content_policy，且不重试', async () => {
    upstream.handler = (url) =>
      url.endsWith('/async')
        ? json({ task_id: 'imgtask_1' }, 202)
        : json({
            status: 'failed',
            http_status: 400,
            error: {
              message:
                'Your request was rejected by the safety system. If you believe this is an error, contact us at help.openai.com.',
            },
          })
    await insertTask('async-safety')

    await runTask('async-safety')

    // 归进 upstream_error 会让界面给出「再试一次」，而原样重试稳定复现同一个拒绝。
    expect(await readTask('async-safety')).toMatchObject({
      status: 'failed',
      errorType: 'content_policy',
      attempt: 0,
    })
    expect(upstream.calls.filter((url) => url.endsWith('/async'))).toHaveLength(1)
  })

  it('keeps the stored id when a retryable failure sends the task back to the queue', async () => {
    upstream.handler = (url) =>
      url.endsWith('/async')
        ? json({ task_id: 'imgtask_1' }, 202)
        : json({ status: 'failed', http_status: 500, error: { message: 'upstream exploded' } })
    await insertTask('async-retryable')

    await runTask('async-retryable')

    // 清掉 id 等于让下一次尝试整份重提；上游没有幂等键，那就是第二次计费。
    expect(await readTask('async-retryable')).toMatchObject({
      status: 'queued',
      attempt: 1,
      taskIds: ['imgtask_1'],
    })
  })

  it('does not resubmit after a partial fan-out leaves one request outcome unknown', async () => {
    let submits = 0
    upstream.handler = (url) => {
      if (!url.endsWith('/async')) return json({ status: 'processing' })
      return ++submits === 1
        ? json({ task_id: 'imgtask_1' }, 202)
        : json({ error: { message: 'nope' } }, 500)
    }
    await insertTask('async-partial', {
      model: 'legacy-image-model',
      request_payload: { prompt: 'p', n: 2 },
    })

    await runTask('async-partial')

    const requeued = await readTask('async-partial')
    expect(requeued).toMatchObject({ status: 'queued', attempt: 1, taskIds: ['imgtask_1'] })

    upstream.calls.length = 0
    submits = 0
    upstream.handler = (url) =>
      url.endsWith('/async')
        ? json({ task_id: `imgtask_${++submits + 1}` }, 202)
        : json({ status: 'completed', result: { data: [{ url: RESULT_URL }] } })
    await db
      .update(schema.tasks)
      .set({ next_retry_at: null })
      .where(eq(schema.tasks.id, 'async-partial'))

    await runTask('async-partial')

    expect(upstream.calls.filter((url) => url.endsWith('/async'))).toHaveLength(0)
    const done = await readTask('async-partial')
    expect(done).toMatchObject({
      status: 'failed',
      errorType: 'upstream_result_unknown',
      taskIds: ['imgtask_1'],
    })
    // 两次派发只换到一个 id，缺失的那次可能已被上游接受；不能自动补交。
    expect(done?.invocations).toBe(2)
    expect(done?.submittedAt).toBe(requeued!.submittedAt)
  })
})

describe('restart recovery', () => {
  it('keeps a pre-upgrade GPT partial fan-out incomplete without resubmitting', async () => {
    await insertTask('gpt-legacy-partial', {
      status: 'in_progress',
      started_at: 1,
      request_payload: { prompt: 'p', n: 2 },
      upstream_task_ids: ['imgtask_1'],
      upstream_submitted_at: Date.now(),
      upstream_invocation_count: 2,
    })
    await recoverTasksByIds(['gpt-legacy-partial'])
    await runTask('gpt-legacy-partial')
    expect(await readTask('gpt-legacy-partial')).toMatchObject({
      status: 'failed',
      errorType: 'upstream_result_unknown',
      invocations: 2,
      taskIds: ['imgtask_1'],
    })
    expect(upstream.calls).toEqual(['http://localhost:9999/v1/images/tasks/imgtask_1'])
  })

  it('resumes a native GPT batch as one request and archives every output', async () => {
    upstream.handler = () =>
      json({ status: 'completed', result: { data: [{ url: RESULT_URL }, { url: RESULT_URL }] } })
    await insertTask('gpt-native-resume', {
      status: 'in_progress',
      started_at: 1,
      request_payload: { prompt: 'p', n: 2 },
      upstream_task_ids: ['imgtask_batch'],
      upstream_submitted_at: Date.now(),
      upstream_invocation_count: 1,
    })
    await recoverTasksByIds(['gpt-native-resume'])
    await runTask('gpt-native-resume')
    expect(await readTask('gpt-native-resume')).toMatchObject({
      status: 'completed',
      invocations: 1,
      taskIds: ['imgtask_batch'],
    })
    const [task] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, 'gpt-native-resume'))
    expect(extractMeta('openai-compat', task?.result_payload).images).toHaveLength(2)
    expect(upstream.calls).toEqual(['http://localhost:9999/v1/images/tasks/imgtask_batch'])
  })

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
    expect(upstream.calls).toEqual(['http://localhost:9999/v1/images/tasks/imgtask_7'])
  })

  it('performs one final lookup for an expired resumed task and accepts a completed result', async () => {
    await insertTask('async-expired', {
      status: 'in_progress',
      started_at: 1,
      upstream_task_ids: ['imgtask_8'],
      upstream_submitted_at: Date.now() - QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS - 1,
      upstream_invocation_count: 1,
    })

    await recoverTasksByIds(['async-expired'])
    await runTask('async-expired')

    expect(await readTask('async-expired')).toMatchObject({ status: 'completed', errorType: null })
    expect(upstream.calls).toEqual(['http://localhost:9999/v1/images/tasks/imgtask_8'])
  })

  it('writes a terminal timeout when the budget expires during a polling sleep', async () => {
    setAsyncPollBackoffForTesting([200])
    await insertTask('async-sleep-timeout', {
      status: 'in_progress',
      started_at: 1,
      upstream_task_ids: ['imgtask_8'],
      upstream_submitted_at: Date.now() - QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS + 60,
      upstream_invocation_count: 1,
    })
    upstream.handler = () => json({ status: 'processing' })

    await recoverTasksByIds(['async-sleep-timeout'])
    await runTask('async-sleep-timeout')

    // 裸 AbortError 会被 isAbortError 当成用户取消直接 return，行就永远卡在 in_progress。
    expect(await readTask('async-sleep-timeout')).toMatchObject({
      status: 'failed',
      errorType: 'upstream_result_unknown',
    })
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
