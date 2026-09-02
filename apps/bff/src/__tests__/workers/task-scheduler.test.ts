import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'
import {
  _setPrivateBffOverlayForTesting,
  EMPTY_PRIVATE_BFF_OVERLAY,
} from '../../lib/private-overlay'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { abortableUpstreamFetch, waitFor } from '../helpers/upstreamStubs'

process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test-key'
const databaseUrl = await resetTestDatabase('bff_task_scheduler')
process.env.DATABASE_URL = databaseUrl
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)
process.env.PORT = '0'

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { close: closeDb, db, schema } = await import('../../db/client')
const { purgeOldTasks, recoverAbandonedTasks, recoverTasksByIds } = await import(
  '../../db/maintenance'
)
const { TaskScheduler } = await import('../../workers/task-scheduler')
const { setUpstreamFetchForTesting } = await import('../../lib/upstream')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { MAX_ATTEMPTS, RETRY_BACKOFF_MS } = await import('../../lib/retry')
let storage: InMemoryObjectStore

beforeEach(() => {
  storage = new InMemoryObjectStore()
  setObjectStoreForTesting(storage)
})

afterEach(() => {
  setObjectStoreForTesting()
})
afterAll(async () => {
  await closeDb()
})

async function insertTask(id: string, provider: 'openai-compat' | 'gemini', submittedAt: number) {
  await db.insert(schema.tasks).values({
    id,
    provider,
    model: 'test-model',
    status: 'queued',
    request_payload: { prompt: id },
    submitted_at: submittedAt,
  })
}

describe('TaskScheduler', () => {
  beforeEach(async () => {
    await db.delete(schema.tasks)
  })

  afterEach(() => {
    setUpstreamFetchForTesting()
    mock.restore()
  })

  it('records the completion time of a successful queue poll', async () => {
    let now = 123_456
    const scheduler = new TaskScheduler({
      pollIntervalMs: 10_000,
      clock: () => now,
    })

    expect(scheduler.lastSuccessfulPollAt()).toBeNull()
    scheduler.start()
    await waitFor(() => scheduler.lastSuccessfulPollAt() === now)
    scheduler.stop()

    now += 1
    expect(scheduler.lastSuccessfulPollAt()).toBe(123_456)
  })

  it('bounds providers independently and keeps the second OpenAI task queued', async () => {
    await insertTask('openai-1', 'openai-compat', 1)
    await insertTask('openai-2', 'openai-compat', 2)
    await insertTask('gemini-1', 'gemini', 3)

    const started: string[] = []
    const resolveTask = new Map<string, () => void>()
    const scheduler = new TaskScheduler({
      pollIntervalMs: 10_000,
      concurrency: { 'openai-compat': 1, gemini: 1 },
      executeTask: async (id) => {
        await db
          .update(schema.tasks)
          .set({ status: 'in_progress' })
          .where(and(eq(schema.tasks.id, id), eq(schema.tasks.status, 'queued')))
        started.push(id)
        await new Promise<void>((resolve) => resolveTask.set(id, resolve))
        await db
          .update(schema.tasks)
          .set({ status: 'completed', completed_at: Date.now() })
          .where(eq(schema.tasks.id, id))
      },
    })

    scheduler.start()
    await waitFor(() => started.length === 2)
    scheduler.stop()
    expect(started).toHaveLength(2)
    expect(started).toEqual(expect.arrayContaining(['openai-1', 'gemini-1']))

    const [secondOpenAI] = await db
      .select({ status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, 'openai-2'))
    expect(secondOpenAI?.status).toBe('queued')

    resolveTask.get('openai-1')?.()
    resolveTask.get('gemini-1')?.()
    await scheduler.waitForIdle(5_000)

    scheduler.start()
    await waitFor(() => started.includes('openai-2'))
    scheduler.stop()
    resolveTask.get('openai-2')?.()
    await scheduler.waitForIdle(5_000)
  })

  it('gives up on waitForIdle once the drain window expires', async () => {
    await insertTask('slow-drain', 'openai-compat', 1)
    let release: (() => void) | undefined
    const scheduler = new TaskScheduler({
      pollIntervalMs: 10_000,
      executeTask: () => new Promise<void>((resolve) => (release = resolve)),
    })

    scheduler.start()
    await waitFor(() => scheduler.activeCount() === 1)
    scheduler.stop()

    expect(await scheduler.waitForIdle(20)).toBe(false)
    release?.()
    expect(await scheduler.waitForIdle(1_000)).toBe(true)
  })

  it('observes a database cancellation and aborts the active request', async () => {
    await insertTask('cancel-active', 'openai-compat', 1)
    setUpstreamFetchForTesting(abortableUpstreamFetch())

    const scheduler = new TaskScheduler({ pollIntervalMs: 10_000 })
    scheduler.start()
    await waitFor(async () => {
      const [row] = await db
        .select({ status: schema.tasks.status })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, 'cancel-active'))
      return row?.status === 'in_progress'
    })

    await db
      .update(schema.tasks)
      .set({ status: 'cancelled', completed_at: Date.now() })
      .where(eq(schema.tasks.id, 'cancel-active'))
    await scheduler.tick()
    await waitFor(() => scheduler.activeCount() === 0)
    scheduler.stop()

    const [row] = await db
      .select({ status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, 'cancel-active'))
    expect(row?.status).toBe('cancelled')
  })
})

describe('recoverAbandonedTasks', () => {
  const now = 1_000_000

  beforeEach(async () => {
    await db.delete(schema.tasks)
  })

  async function insertInProgress(id: string, startedAt: number, attemptCount = 0) {
    await db.insert(schema.tasks).values({
      id,
      provider: 'openai-compat',
      model: 'test-model',
      status: 'in_progress',
      request_payload: { prompt: id },
      submitted_at: startedAt,
      started_at: startedAt,
      attempt_count: attemptCount,
      error_message: 'stale error text',
      error_type: 'upstream_error',
    })
  }

  it('requeues abandoned rows and leaves queued schedules untouched', async () => {
    await insertTask('queued-due', 'openai-compat', 1)
    await db.insert(schema.tasks).values({
      id: 'queued-future',
      provider: 'openai-compat',
      model: 'test-model',
      status: 'queued',
      request_payload: { prompt: 'future' },
      submitted_at: 2,
      attempt_count: 1,
      next_retry_at: now + 60_000,
    })
    await insertInProgress('abandoned', now - QUEUE_TIMEOUTS.STALE_IN_PROGRESS_MS - 1)

    expect(await recoverAbandonedTasks([], now)).toEqual({
      requeued: 1,
      failed: 0,
      resumedPolling: 0,
    })

    const rows = await db
      .select({
        id: schema.tasks.id,
        status: schema.tasks.status,
        attempt: schema.tasks.attempt_count,
        next: schema.tasks.next_retry_at,
        errorMessage: schema.tasks.error_message,
      })
      .from(schema.tasks)
    expect(rows.find((row) => row.id === 'queued-due')).toMatchObject({
      status: 'queued',
      attempt: 0,
    })
    expect(rows.find((row) => row.id === 'queued-future')).toMatchObject({
      status: 'queued',
      attempt: 1,
      next: now + 60_000,
    })
    expect(rows.find((row) => row.id === 'abandoned')).toMatchObject({
      status: 'queued',
      attempt: 1,
      next: now + RETRY_BACKOFF_MS[0],
      errorMessage: null,
    })
  })

  it('skips rows that are still young or still owned by this process', async () => {
    await insertInProgress('recent', now - 1_000)
    await insertInProgress('owned', now - QUEUE_TIMEOUTS.STALE_IN_PROGRESS_MS - 1)

    expect(await recoverAbandonedTasks(['owned'], now)).toEqual({
      requeued: 0,
      failed: 0,
      resumedPolling: 0,
    })

    const rows = await db.select({ status: schema.tasks.status }).from(schema.tasks)
    expect(rows.every((row) => row.status === 'in_progress')).toBe(true)
  })

  it('fails a row whose retry budget is spent so billing reversal still runs', async () => {
    await insertInProgress('spent', now - QUEUE_TIMEOUTS.STALE_IN_PROGRESS_MS - 1, MAX_ATTEMPTS - 1)

    expect(await recoverAbandonedTasks([], now)).toEqual({
      requeued: 0,
      failed: 1,
      resumedPolling: 0,
    })

    const [row] = await db
      .select({
        status: schema.tasks.status,
        errorType: schema.tasks.error_type,
        completedAt: schema.tasks.completed_at,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, 'spent'))
    expect(row).toMatchObject({
      status: 'failed',
      errorType: 'interrupted',
      completedAt: now,
    })
  })

  it('recovers a named row regardless of age and ignores an empty id list', async () => {
    await insertInProgress('named', now - 1_000)

    expect(await recoverTasksByIds([], now)).toEqual({ requeued: 0, failed: 0, resumedPolling: 0 })
    expect(await recoverTasksByIds(['named'], now)).toEqual({
      requeued: 1,
      failed: 0,
      resumedPolling: 0,
    })

    const [row] = await db
      .select({ status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, 'named'))
    expect(row?.status).toBe('queued')
  })
})

describe('purgeOldTasks', () => {
  beforeEach(async () => {
    await db.delete(schema.tasks)
  })

  it('deletes rows before their object prefixes', async () => {
    await db.insert(schema.tasks).values({
      id: 'expired-task',
      provider: 'openai-compat',
      model: 'test-model',
      status: 'completed',
      request_payload: { prompt: 'expired' },
      result_payload: { data: [{ object: 'expired-task/out/0', mime: 'image/png' }] },
      submitted_at: 1,
      completed_at: Date.now() - 1_000,
    })
    await storage.write('expired-task/in/0', Buffer.from('input'), 'image/png')
    await storage.write('expired-task/out/0', Buffer.from('output'), 'image/png')
    storage.beforeDeletePrefix = async (prefix) => {
      expect(prefix).toBe('expired-task/')
      const rows = await db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, 'expired-task'))
      expect(rows).toHaveLength(0)
    }

    expect(await purgeOldTasks(1)).toBe(1)
    expect(storage.objects.size).toBe(0)
  })

  it('leaves a harmless lifecycle orphan when prefix deletion is interrupted', async () => {
    await db.insert(schema.tasks).values({
      id: 'orphan-task',
      provider: 'openai-compat',
      model: 'test-model',
      status: 'failed',
      request_payload: { prompt: 'expired' },
      submitted_at: 1,
      completed_at: Date.now() - 1_000,
    })
    await storage.write('orphan-task/out/0', Buffer.from('orphan'), 'image/png')
    storage.deleteFailuresRemaining = 1

    expect(await purgeOldTasks(1)).toBe(1)
    expect(
      await db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, 'orphan-task')),
    ).toHaveLength(0)
    expect(storage.objects.has('orphan-task/out/0')).toBe(true)
  })
})
