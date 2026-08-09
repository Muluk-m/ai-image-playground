import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { and, eq } from 'drizzle-orm'
import { runPrivateMigrations } from '../../lib/private-overlay'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test-key'
const databaseUrl = await resetTestDatabase('bff_task_scheduler')
await runPrivateMigrations(databaseUrl)
process.env.DATABASE_URL = databaseUrl
process.env.PORT = '0'

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { close: closeDb, db, schema } = await import('../../db/client')
const { purgeOldTasks, recoverInterruptedTasks } = await import('../../db/maintenance')
const { TaskScheduler } = await import('../../workers/task-scheduler')
const { setUpstreamFetchForTesting } = await import('../../lib/upstream')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
type TestFetch = NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>
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

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await Bun.sleep(5)
  }
}

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
    await scheduler.waitForIdle()

    scheduler.start()
    await waitFor(() => started.includes('openai-2'))
    scheduler.stop()
    resolveTask.get('openai-2')?.()
    await scheduler.waitForIdle()
  })

  it('observes a database cancellation and aborts the active request', async () => {
    await insertTask('cancel-active', 'openai-compat', 1)
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

describe('recoverInterruptedTasks', () => {
  beforeEach(async () => {
    await db.delete(schema.tasks)
  })

  it('fails stale in-progress rows but leaves queued retry schedules untouched', async () => {
    await insertTask('queued-due', 'openai-compat', 1)
    await db.insert(schema.tasks).values({
      id: 'queued-future',
      provider: 'openai-compat',
      model: 'test-model',
      status: 'queued',
      request_payload: { prompt: 'future' },
      submitted_at: 2,
      attempt_count: 1,
      next_retry_at: Date.now() + 60_000,
    })
    await db.insert(schema.tasks).values({
      id: 'stale-running',
      provider: 'openai-compat',
      model: 'test-model',
      status: 'in_progress',
      request_payload: { prompt: 'stale' },
      submitted_at: 3,
      started_at: 4,
    })

    expect(await recoverInterruptedTasks()).toEqual({ failed: 1 })
    const rows = await db
      .select({
        id: schema.tasks.id,
        status: schema.tasks.status,
        next: schema.tasks.next_retry_at,
      })
      .from(schema.tasks)
    expect(rows.find((row) => row.id === 'queued-due')?.status).toBe('queued')
    expect(rows.find((row) => row.id === 'queued-future')).toMatchObject({
      status: 'queued',
      next: expect.any(Number),
    })
    expect(rows.find((row) => row.id === 'stale-running')?.status).toBe('failed')
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
