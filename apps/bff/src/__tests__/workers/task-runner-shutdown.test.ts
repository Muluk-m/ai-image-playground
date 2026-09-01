import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import {
  _setPrivateBffOverlayForTesting,
  EMPTY_PRIVATE_BFF_OVERLAY,
} from '../../lib/private-overlay'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { abortableUpstreamFetch, waitFor } from '../helpers/upstreamStubs'

process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test-key'
const databaseUrl = await resetTestDatabase('bff_task_runner_shutdown')
process.env.DATABASE_URL = databaseUrl
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)
process.env.PORT = '0'

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { close: closeDb, db, schema } = await import('../../db/client')
const { abortAllRunningTasks, abortRunningTask, runningTaskIds, runTask } = await import(
  '../../workers/task-runner'
)
const { recoverTasksByIds } = await import('../../db/maintenance')
const { setUpstreamFetchForTesting } = await import('../../lib/upstream')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { MAX_ATTEMPTS, RETRY_BACKOFF_MS } = await import('../../lib/retry')

beforeEach(async () => {
  setObjectStoreForTesting(new InMemoryObjectStore())
  await db.delete(schema.tasks)
  setUpstreamFetchForTesting(abortableUpstreamFetch())
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
 * Starts runTask and resolves once its abort controller is registered, so the abort
 * lands mid-flight. The pending run is wrapped because an async return would await it.
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
  // The controller is registered after the claim, so waiting on the row status alone races.
  await waitFor(() => runningTaskIds().includes(id), 2_000)
  return { running }
}

/** The shutdown sequence from worker-index: snapshot ids, abort, settle, recover. */
async function abortForShutdown(running: Promise<void>): Promise<void> {
  const aborted = runningTaskIds()
  abortAllRunningTasks()
  await running
  await recoverTasksByIds(aborted)
}

describe('shutdown abort', () => {
  it('requeues the task with the next retry attempt', async () => {
    const { running } = await startInflightTask('drain-requeue')

    await abortForShutdown(running)

    const row = await readTask('drain-requeue')
    expect(row).toMatchObject({ status: 'queued', attempt: 1, errorType: null })
    expect(row?.next).toBeGreaterThanOrEqual(Date.now() - RETRY_BACKOFF_MS[0])
    expect(row?.completedAt).toBeNull()
  })

  it('fails the task once the retry budget is spent', async () => {
    const { running } = await startInflightTask('drain-exhausted', MAX_ATTEMPTS - 1)

    await abortForShutdown(running)

    expect(await readTask('drain-exhausted')).toMatchObject({
      status: 'failed',
      errorType: 'interrupted',
      attempt: MAX_ATTEMPTS,
    })
  })

  it('leaves a cancelled row alone even when shutdown aborts it in the same breath', async () => {
    const { running } = await startInflightTask('drain-after-cancel')
    await db
      .update(schema.tasks)
      .set({ status: 'cancelled', completed_at: 42 })
      .where(eq(schema.tasks.id, 'drain-after-cancel'))

    await abortForShutdown(running)

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

  it('never requeues a row on its own, unlike the shutdown path', async () => {
    const { running } = await startInflightTask('cancel-inflight')

    expect(abortRunningTask('cancel-inflight')).toBe(true)
    await running

    expect(await readTask('cancel-inflight')).toMatchObject({ status: 'in_progress', attempt: 0 })
  })
})
