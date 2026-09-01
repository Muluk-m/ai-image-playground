import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import {
  _setPrivateBffOverlayForTesting,
  EMPTY_PRIVATE_BFF_OVERLAY,
} from '../../lib/private-overlay'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test-key'
const databaseUrl = await resetTestDatabase('bff_task_runner_archive_retry')
process.env.DATABASE_URL = databaseUrl
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)
process.env.PORT = '0'

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { close: closeDb, db, schema } = await import('../../db/client')
const { runTask } = await import('../../workers/task-runner')
const { setUpstreamFetchForTesting } = await import('../../lib/upstream')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { MAX_ATTEMPTS, RETRY_BACKOFF_MS } = await import('../../lib/retry')

const SOURCE_URL = 'https://imgen.example/generated.png'

let store: InstanceType<typeof InMemoryObjectStore>
const realFetch = globalThis.fetch

/** 上游只需回一个 200 JSON body；transport 细节由 lib/upstream 的注入点接管。 */
function upstreamReturning(payload: unknown) {
  return mock(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  })) as unknown as Parameters<typeof setUpstreamFetchForTesting>[0]
}

beforeEach(async () => {
  store = new InMemoryObjectStore()
  setObjectStoreForTesting(store)
  await db.delete(schema.tasks)
})

afterEach(() => {
  setUpstreamFetchForTesting()
  setObjectStoreForTesting()
  globalThis.fetch = realFetch
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
      next: schema.tasks.next_retry_at,
      errorType: schema.tasks.error_type,
      errorMessage: schema.tasks.error_message,
      completedAt: schema.tasks.completed_at,
      invocations: schema.tasks.upstream_invocation_count,
    })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, id))
  return row
}

async function insertQueuedTask(id: string, attemptCount = 0): Promise<void> {
  await db.insert(schema.tasks).values({
    id,
    provider: 'openai-compat',
    model: 'test-model',
    status: 'queued',
    request_payload: { prompt: id },
    submitted_at: 1,
    attempt_count: attemptCount,
  })
}

describe('archive source image fetch', () => {
  beforeEach(() => {
    setUpstreamFetchForTesting(upstreamReturning({ data: [{ url: SOURCE_URL }] }))
    globalThis.fetch = (async () =>
      new Response('forbidden', { status: 403 })) as unknown as typeof fetch
  })

  it('回源取图 403 时退回 queued 并推进 attempt', async () => {
    await insertQueuedTask('archive-403')

    await runTask('archive-403')

    const row = await readTask('archive-403')
    expect(row).toMatchObject({ status: 'queued', attempt: 1, errorType: null })
    expect(row?.completedAt).toBeNull()
    expect(row?.next).toBeGreaterThanOrEqual(Date.now() + RETRY_BACKOFF_MS[0]! - 5_000)
    // 重试会再打一次上游，本次尝试的记账照旧落在 dispatch 上。
    expect(row?.invocations).toBe(1)
    expect(store.objects.size).toBe(0)
  })

  it('重试预算耗尽后落终态 object_storage_error', async () => {
    await insertQueuedTask('archive-403-exhausted', MAX_ATTEMPTS - 1)

    await runTask('archive-403-exhausted')

    const row = await readTask('archive-403-exhausted')
    expect(row).toMatchObject({ status: 'failed', errorType: 'object_storage_error' })
    expect(row?.errorMessage).toContain('source image HTTP 403')
    expect(row?.completedAt).not.toBeNull()
  })

  it('回源 fetch 抛网络错同样可重试', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    await insertQueuedTask('archive-network')

    await runTask('archive-network')

    expect(await readTask('archive-network')).toMatchObject({ status: 'queued', attempt: 1 })
  })
})

describe('object store write failure', () => {
  it('R2 写入失败仍是终态失败，不进重试预算', async () => {
    setUpstreamFetchForTesting(upstreamReturning({ data: [{ b64_json: 'AAAA' }] }))
    globalThis.fetch = (() => {
      throw new Error('unexpected network fetch')
    }) as unknown as typeof fetch
    store.writeFailuresRemaining = 10
    await insertQueuedTask('archive-write-fail')

    await runTask('archive-write-fail')

    const row = await readTask('archive-write-fail')
    expect(row).toMatchObject({
      status: 'failed',
      errorType: 'object_storage_error',
      attempt: 0,
    })
    expect(row?.errorMessage).toContain('Object storage write failed')
  })
})
