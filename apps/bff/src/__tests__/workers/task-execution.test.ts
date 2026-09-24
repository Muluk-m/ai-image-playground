import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'
import { forbidGlobalFetch, waitFor } from '../helpers/upstreamStubs'

process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test-key'
process.env.DATABASE_URL = await resetTestDatabase('bff_task_execution')
process.env.PORT = '0'
const billing = installRecordingTaskHooks()

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { close: closeDb, db, schema } = await import('../../db/client')
const { abortRunningTask, claimTaskExecution, runningTaskIds, setTaskHeartbeatForTesting } =
  await import('../../workers/task-execution')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { setDurableMediaStoreForTesting } = await import('../../lib/durableMediaStore')

type DurableFixture = InMemoryObjectStore & { sign: (key: string) => string }

let store: InMemoryObjectStore
let durable: DurableFixture
let restoreFetch: () => void

beforeEach(async () => {
  billing.reset()
  store = new InMemoryObjectStore()
  durable = Object.assign(new InMemoryObjectStore(), {
    sign: (key: string) => `https://durable.invalid/${key}`,
  })
  setObjectStoreForTesting(store)
  setDurableMediaStoreForTesting(durable)
  restoreFetch = forbidGlobalFetch()
  await db.delete(schema.tasks)
})

afterEach(() => {
  setTaskHeartbeatForTesting()
  setObjectStoreForTesting()
  setDurableMediaStoreForTesting()
  restoreFetch()
})

afterAll(async () => {
  await closeDb()
})

const PLAIN_INPUT = {
  prompt: 'preserve me',
  device_id: 'exec-device',
  input_images: [{ object: 'stale/in/0', mime: 'image/png' }],
}

async function insertQueuedTask(
  id: string,
  values: Partial<typeof schema.tasks.$inferInsert> = {},
): Promise<void> {
  await db.insert(schema.tasks).values({
    id,
    provider: 'openai-compat',
    model: 'test-model',
    status: 'queued',
    request_payload: { prompt: id, device_id: 'exec-device' },
    submitted_at: 1,
    ...values,
  })
}

async function readTask(id: string) {
  const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id))
  return row
}

/** 另一个实例接手了这一行：令牌换人，租约还新鲜。 */
async function takeOver(id: string): Promise<void> {
  await db
    .update(schema.tasks)
    .set({ execution_token: 'new-owner', lease_expires_at: Date.now() + 60_000 })
    .where(eq(schema.tasks.id, id))
}

describe('认领', () => {
  it('serializes account claims and applies the plan limit without blocking another account', async () => {
    const user = (id: string) => ({
      id,
      username: id,
      password_hash: 'test',
      created_at: Date.now(),
      updated_at: Date.now(),
    })
    await db.insert(schema.users).values([user('account-a'), user('account-b')])
    await insertQueuedTask('account-a-1', { user_id: 'account-a' })
    await insertQueuedTask('account-a-2', { user_id: 'account-a' })
    await insertQueuedTask('account-b-1', { user_id: 'account-b' })
    billing.concurrencyLimit = 1

    const [first, second] = await Promise.all([
      claimTaskExecution('account-a-1'),
      claimTaskExecution('account-a-2'),
    ])
    expect([first, second].filter(Boolean)).toHaveLength(1)
    const other = await claimTaskExecution('account-b-1')
    expect(other).not.toBeNull()
    first?.release()
    second?.release()
    other?.release()
  })

  it('同一条排着的任务只有一个执行者认领得到', async () => {
    await insertQueuedTask('single-claim')

    const outcomes = await Promise.all([
      claimTaskExecution('single-claim'),
      claimTaskExecution('single-claim'),
    ])

    const claimed = outcomes.filter((execution) => execution !== null)
    expect(claimed).toHaveLength(1)
    claimed[0]!.release()
    expect((await readTask('single-claim'))?.status).toBe('in_progress')
  })

  it('重试时刻还没到的任务认领不到', async () => {
    await insertQueuedTask('waiting', { next_retry_at: Date.now() + 60_000 })

    expect(await claimTaskExecution('waiting')).toBeNull()
    expect((await readTask('waiting'))?.status).toBe('queued')
  })
})

describe('租约', () => {
  it('续不上租约就中止上游', async () => {
    setTaskHeartbeatForTesting(5)
    await insertQueuedTask('lost-lease')
    const execution = await claimTaskExecution('lost-lease')
    expect(execution!.signal.aborted).toBe(false)

    await takeOver('lost-lease')

    await waitFor(() => execution!.signal.aborted, 2_000)
    execution!.release()
  })

  it('心跳把租约往后推', async () => {
    setTaskHeartbeatForTesting(5)
    await insertQueuedTask('renewed')
    const execution = await claimTaskExecution('renewed')
    const claimedLease = (await readTask('renewed'))?.lease_expires_at

    await waitFor(
      async () => ((await readTask('renewed'))?.lease_expires_at ?? 0) > claimedLease!,
      2_000,
    )
    execution!.release()

    expect(execution!.signal.aborted).toBe(false)
  })
})

describe('输入保全', () => {
  it('被接手之后保全输入写不进 request_payload', async () => {
    await insertQueuedTask('stale', { request_payload: PLAIN_INPUT })
    await store.write('stale/in/0', new Uint8Array([1, 2, 3]), 'image/png')
    const execution = await claimTaskExecution('stale')
    await takeOver('stale')

    expect(await execution!.preserveInputs(PLAIN_INPUT)).toBeNull()
    execution!.release()

    expect((await readTask('stale'))?.request_payload).toEqual(PLAIN_INPUT)
  })

  it('还持有租约时保全输入把原件换成 durable 引用', async () => {
    await insertQueuedTask('preserve', { request_payload: PLAIN_INPUT })
    await store.write('stale/in/0', new Uint8Array([1, 2, 3]), 'image/png')
    const execution = await claimTaskExecution('preserve')

    const preserved = await execution!.preserveInputs(PLAIN_INPUT)
    execution!.release()

    expect(preserved?.input_images).toEqual([
      { object: 'stale/in/0', mime: 'image/png', store: 'durable' },
    ])
    expect((await readTask('preserve'))?.request_payload).toEqual(preserved!)
    expect(durable.objects.has('stale/in/0')).toBe(true)
  })
})

describe('收尾', () => {
  it('被接手的执行者收不了尾，也不触发结算', async () => {
    await insertQueuedTask('replaced')
    const execution = await claimTaskExecution('replaced')
    await takeOver('replaced')

    expect(await execution!.finish({ status: 'completed', completedAt: Date.now() })).toBe(false)
    execution!.release()

    expect(billing.settlements).toHaveLength(0)
    expect((await readTask('replaced'))?.status).toBe('in_progress')
  })

  it('租约过期之后连自己也收不了尾', async () => {
    await insertQueuedTask('expired')
    const execution = await claimTaskExecution('expired')
    await db
      .update(schema.tasks)
      .set({ lease_expires_at: Date.now() - 1 })
      .where(eq(schema.tasks.id, 'expired'))

    expect(await execution!.finish({ status: 'completed', completedAt: Date.now() })).toBe(false)
    execution!.release()

    expect(billing.settlements).toHaveLength(0)
  })

  it('持有租约的执行者收尾一次，重复收尾不再结算', async () => {
    await insertQueuedTask('settled')
    const execution = await claimTaskExecution('settled')

    const finish = () => execution!.finish({ status: 'completed', completedAt: Date.now() })
    expect(await finish()).toBe(true)
    expect(await finish()).toBe(false)
    execution!.release()

    expect(billing.settlements).toMatchObject([{ taskId: 'settled', outcome: 'completed' }])
  })
})

describe('记账与回队', () => {
  it('被接手之后记不上调用次数，也落不下上游 id', async () => {
    await insertQueuedTask('stale-records')
    const execution = await claimTaskExecution('stale-records')
    await takeOver('stale-records')

    expect(await execution!.recordUpstreamInvocation()).toBe(false)
    await execution!.recordUpstreamTaskIds(['imgtask_9'], false)
    expect(await execution!.readUpstreamSubmission()).toBeUndefined()
    execution!.release()

    expect(await readTask('stale-records')).toMatchObject({
      upstream_invocation_count: 0,
      upstream_task_ids: null,
    })
  })

  it('记账与上游 id 落在自己这一行上，回读拿得到', async () => {
    await insertQueuedTask('records')
    const execution = await claimTaskExecution('records')

    expect(await execution!.recordUpstreamInvocation()).toBe(true)
    await execution!.recordUpstreamTaskIds(['imgtask_1'], false)
    const submission = await execution!.readUpstreamSubmission()
    execution!.release()

    expect(submission).toMatchObject({ taskIds: ['imgtask_1'], invocationCount: 1 })
    expect(submission!.submittedAt).toBeGreaterThan(0)
  })

  it('被接手之后回队与存档检查点都写不动', async () => {
    await insertQueuedTask('stale-requeue')
    const execution = await claimTaskExecution('stale-requeue')
    await takeOver('stale-requeue')

    expect(await execution!.saveCheckpoint({ outputs: [] })).toBe(false)
    expect(await execution!.requeue(1, Date.now() + 1_000)).toBe(false)
    expect(await execution!.requeueArchive(Date.now() + 1_000, { outputs: [] })).toBe(false)
    execution!.release()

    expect(await readTask('stale-requeue')).toMatchObject({
      status: 'in_progress',
      attempt_count: 0,
      archive_payload: null,
    })
  })
})

describe('进程内登记', () => {
  it('在跑的执行按 id 打断得了，release 之后不再登记', async () => {
    await insertQueuedTask('registered')
    const execution = await claimTaskExecution('registered')

    expect(runningTaskIds()).toContain('registered')
    expect(abortRunningTask('registered')).toBe(true)
    expect(execution!.signal.aborted).toBe(true)

    execution!.release()
    expect(runningTaskIds()).not.toContain('registered')
    expect(abortRunningTask('registered')).toBe(false)
  })
})
