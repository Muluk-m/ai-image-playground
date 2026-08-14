import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Buffer } from 'node:buffer'
import { and, eq } from 'drizzle-orm'
import sharp from 'sharp'
import { getTaskBlob, insertTaskBlobs, listTaskBlobs } from '../../lib/blobStore'

process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test-key'
process.env.DATABASE_URL = './artifacts/test-routes.sqlite'
process.env.PORT = '0'

const { runMigrations } = await import('../../db/migrate')
runMigrations()
const { db, schema } = await import('../../db/client')
const { purgeOldOutputBlobs, recoverInterruptedTasks } = await import('../../db/maintenance')
const { TaskScheduler } = await import('../../workers/task-scheduler')
const { runTask } = await import('../../workers/task-runner')
const { setUpstreamFetchForTesting } = await import('../../lib/upstream')
type TestFetch = NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>

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
    expect(started).toEqual(['openai-1', 'gemini-1'])

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

describe('task blob lifecycle', () => {
  beforeEach(async () => {
    await db.delete(schema.tasks)
  })

  afterEach(() => {
    setUpstreamFetchForTesting()
    mock.restore()
  })

  it('rolls back output blobs when cancellation wins the completion race', async () => {
    await insertTask('cancel-completion-race', 'openai-compat', Date.now())
    let releaseResponse: (response: Response) => void = () => {}
    let markStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const upstreamResponse = new Promise<Response>((resolve) => {
      releaseResponse = resolve
    })
    setUpstreamFetchForTesting(async () => {
      markStarted()
      return upstreamResponse
    })

    const running = runTask('cancel-completion-race')
    await started
    await db
      .update(schema.tasks)
      .set({ status: 'cancelled', completed_at: Date.now() })
      .where(eq(schema.tasks.id, 'cancel-completion-race'))
    releaseResponse(
      new Response(
        JSON.stringify({ data: [{ b64_json: Buffer.from('pixel').toString('base64') }] }),
        { headers: { 'content-type': 'application/json' } },
      ),
    )
    await running

    const [task] = await db
      .select({ status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, 'cancel-completion-race'))
    expect(task?.status).toBe('cancelled')
    expect(await listTaskBlobs('cancel-completion-race', 'output', db)).toEqual([])
  })

  it('archives original inputs left by a cancelled worker during startup recovery', async () => {
    const png = await sharp({
      create: { width: 2, height: 2, channels: 4, background: '#336699' },
    })
      .png()
      .toBuffer()
    await db.insert(schema.tasks).values({
      id: 'cancelled-original-input',
      provider: 'openai-compat',
      model: 'test-model',
      status: 'cancelled',
      request_payload: { prompt: 'cancelled', input_images: [{ $blob: 0 }] },
      submitted_at: Date.now(),
      completed_at: Date.now(),
    })
    insertTaskBlobs(
      'cancelled-original-input',
      [{ kind: 'input', idx: 0, mime: 'image/png', data: png }],
      db,
    )

    expect(await recoverInterruptedTasks()).toEqual({ failed: 0 })
    expect(await getTaskBlob('cancelled-original-input', 'input', 0, db)).toMatchObject({
      mime: 'image/webp',
    })
  })

  it('purges only expired output blobs', async () => {
    await db.insert(schema.tasks).values({
      id: 'output-retention',
      provider: 'openai-compat',
      model: 'test-model',
      status: 'completed',
      request_payload: { prompt: 'retention' },
      submitted_at: Date.now(),
      completed_at: Date.now(),
    })
    const now = Date.now()
    insertTaskBlobs(
      'output-retention',
      [
        {
          kind: 'output',
          idx: 0,
          mime: 'image/png',
          data: Buffer.from('expired'),
          createdAt: now - 200_000,
        },
        {
          kind: 'output',
          idx: 1,
          mime: 'image/png',
          data: Buffer.from('fresh'),
          createdAt: now,
        },
        {
          kind: 'input',
          idx: 0,
          mime: 'image/webp',
          data: Buffer.from('input'),
          createdAt: now - 200_000,
        },
      ],
      db,
    )

    expect(await purgeOldOutputBlobs(100_000)).toBe(1)
    expect((await listTaskBlobs('output-retention', 'output', db)).map((blob) => blob.idx)).toEqual(
      [1],
    )
    expect(await getTaskBlob('output-retention', 'input', 0, db)).toBeDefined()
  })
})
