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
const databaseUrl = await resetTestDatabase('bff_task_runner_shutdown')
process.env.DATABASE_URL = databaseUrl
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)
process.env.PORT = '0'

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { close: closeDb, db, schema } = await import('../../db/client')
const { abortRunningTask, abortRunningTasksForShutdown, runningTaskIds, runTask } = await import(
  '../../workers/task-runner'
)
const { setUpstreamFetchForTesting } = await import('../../lib/upstream')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { MAX_ATTEMPTS, RETRY_BACKOFF_MS } = await import('../../lib/retry')
type TestFetch = NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>

beforeEach(async () => {
  setObjectStoreForTesting(new InMemoryObjectStore())
  await db.delete(schema.tasks)
  // Never resolves on its own: every case below decides how the request is aborted.
  setUpstreamFetchForTesting(
    mock(async (_input, init) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal
        const rejectAbort = () => reject(new DOMException('Aborted', 'AbortError'))
        if (signal?.aborted) return rejectAbort()
        signal?.addEventListener('abort', rejectAbort, { once: true })
      })
    }) as unknown as TestFetch,
  )
})

afterEach(() => {
  setUpstreamFetchForTesting()
  setObjectStoreForTesting()
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
      completedAt: schema.tasks.completed_at,
    })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, id))
  return row
}

/**
 * Starts runTask and resolves once the row is claimed, so the abort lands mid-flight.
 * The pending run is wrapped because an async return would await it instead.
 */
async function startInflightTask(
  id: string,
  attemptCount = 0,
): Promise<{ running: Promise<void> }> {
  await db.insert(schema.tasks).values({
    id,
    provider: 'openai-compat',
    model: 'test-model',
    status: 'queued',
    request_payload: { prompt: id },
    submitted_at: 1,
    attempt_count: attemptCount,
  })
  const running = runTask(id)
  // The abort controller is registered after the claim, so waiting on the row status alone races.
  const deadline = Date.now() + 2_000
  while (!runningTaskIds().includes(id)) {
    if (Date.now() >= deadline) throw new Error('task never registered an abort controller')
    await Bun.sleep(5)
  }
  return { running }
}

describe('shutdown abort', () => {
  it('requeues the task with the next retry attempt', async () => {
    const { running } = await startInflightTask('drain-requeue')

    expect(abortRunningTasksForShutdown()).toBe(1)
    await running

    const row = await readTask('drain-requeue')
    expect(row).toMatchObject({ status: 'queued', attempt: 1, errorType: null })
    expect(row?.next).toBeGreaterThanOrEqual(Date.now() - RETRY_BACKOFF_MS[0])
    expect(row?.completedAt).toBeNull()
  })

  it('fails the task once the retry budget is spent', async () => {
    const { running } = await startInflightTask('drain-exhausted', MAX_ATTEMPTS - 1)

    abortRunningTasksForShutdown()
    await running

    expect(await readTask('drain-exhausted')).toMatchObject({
      status: 'failed',
      errorType: 'interrupted',
    })
  })

  it('leaves a cancelled row alone even when shutdown aborts it in the same breath', async () => {
    const { running } = await startInflightTask('drain-after-cancel')
    await db
      .update(schema.tasks)
      .set({ status: 'cancelled', completed_at: 42 })
      .where(eq(schema.tasks.id, 'drain-after-cancel'))

    abortRunningTasksForShutdown()
    await running

    expect(await readTask('drain-after-cancel')).toMatchObject({
      status: 'cancelled',
      attempt: 0,
      completedAt: 42,
    })
  })
})

describe('cancel abort', () => {
  it('writes no terminal state of its own, so the cancel route stays authoritative', async () => {
    const { running } = await startInflightTask('cancel-requested')
    await db
      .update(schema.tasks)
      .set({ status: 'cancelled', completed_at: 7 })
      .where(eq(schema.tasks.id, 'cancel-requested'))

    expect(abortRunningTask('cancel-requested')).toBe(true)
    await running

    expect(await readTask('cancel-requested')).toMatchObject({
      status: 'cancelled',
      attempt: 0,
      completedAt: 7,
    })
  })

  it('never requeues an in-progress row it aborted', async () => {
    const { running } = await startInflightTask('cancel-inflight')

    expect(abortRunningTask('cancel-inflight')).toBe(true)
    await running

    // The cancel route owns the terminal write; the runner must not turn this into a retry.
    expect(await readTask('cancel-inflight')).toMatchObject({ status: 'in_progress', attempt: 0 })
  })
})
