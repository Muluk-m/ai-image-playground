import { afterAll, afterEach, beforeEach, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { type AlertMessage, QUEUE_TIMEOUTS } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'

process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test-key'
process.env.UPSTREAM_ASYNC_IMAGE_TASKS = 'true'
process.env.DATABASE_URL = await resetTestDatabase('bff_auto_reconcile')
process.env.PORT = '0'
const billing = installRecordingTaskHooks()

const { close, db, schema } = await import('../../db/client')
const { reconcileTasks } = await import('../../db/task-transitions')
const { autoReconcileTasks, setAutoReconcileAlertSenderForTesting } = await import(
  '../../lib/auto-reconcile'
)
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { setUpstreamFetchForTesting } = await import('../../lib/upstream')

const now = 1_790_000_000_000
const minute = 60_000

let upstreamBody: unknown = { status: 'processing' }
const sent: AlertMessage[] = []
let failSend = false

beforeEach(async () => {
  billing.reset()
  sent.length = 0
  failSend = false
  upstreamBody = { status: 'processing' }
  setObjectStoreForTesting(new InMemoryObjectStore())
  setUpstreamFetchForTesting(async () => Response.json(upstreamBody))
  setAutoReconcileAlertSenderForTesting(async (messages) => {
    if (failSend) throw new Error('webhook down')
    sent.push(...messages)
  })
  await db.delete(schema.operator_audits)
  await db.delete(schema.tasks)
})

afterEach(() => {
  setUpstreamFetchForTesting()
  setObjectStoreForTesting()
  setAutoReconcileAlertSenderForTesting()
})

afterAll(async () => {
  await close()
})

async function insertReconciling(
  id: string,
  values: Partial<typeof schema.tasks.$inferInsert> = {},
): Promise<void> {
  await db.insert(schema.tasks).values({
    id,
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status: 'reconciling',
    reconciliation_required: true,
    request_payload: { prompt: id, device_id: 'reconcile-device' },
    submitted_at: now - 60 * minute,
    upstream_task_ids: [`imgtask_${id}`],
    upstream_invocation_count: 1,
    reconcile_started_at: now - 6 * minute,
    next_retry_at: now - minute,
    ...values,
  })
}

async function readTask(id: string) {
  const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id))
  return row
}

it('records when confirmation started and waits five minutes before the first check', async () => {
  await db.insert(schema.tasks).values({
    id: 'just-entered',
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status: 'in_progress',
    reconciliation_required: true,
    request_payload: { prompt: 'just-entered', device_id: 'reconcile-device' },
    submitted_at: now,
    upstream_invocation_count: 1,
  })
  expect(await reconcileTasks(eq(schema.tasks.id, 'just-entered'), 'worker aborted')).toEqual([
    'just-entered',
  ])
  const row = await readTask('just-entered')
  expect(row?.next_retry_at! - row?.reconcile_started_at!).toBe(
    QUEUE_TIMEOUTS.AUTO_RECONCILE_AFTER_MS,
  )
  expect(row?.reconcile_alerted_at).toBeNull()
  await autoReconcileTasks(row!.reconcile_started_at!)
  expect((await readTask('just-entered'))?.next_retry_at).toBe(row?.next_retry_at)
  expect(billing.settlements).toHaveLength(0)
})

it('rotates past permanently pending tasks and does not refund while upstream is still generating', async () => {
  for (let index = 0; index < 6; index++) {
    await insertReconciling(`pending-${index}`, {
      next_retry_at: now - (6 - index) * minute,
      upstream_task_ids: [`imgtask_pending_${index}`],
    })
  }
  await autoReconcileTasks(now)
  const afterFirst = await Promise.all(
    Array.from({ length: 6 }, (_, index) => readTask(`pending-${index}`)),
  )
  for (const row of afterFirst) {
    expect(row?.status).toBe('reconciling')
    expect(row?.error_type).not.toBe('upstream_no_image')
  }
  expect(afterFirst.slice(0, 5).every((row) => (row?.next_retry_at ?? 0) > now)).toBe(true)
  expect(afterFirst[5]?.next_retry_at).toBe(now - minute)
  expect(billing.settlements).toHaveLength(0)

  await autoReconcileTasks(now)
  const sixth = await readTask('pending-5')
  expect(sixth?.status).toBe('reconciling')
  expect(sixth?.next_retry_at).toBeGreaterThan(now)
  expect(billing.settlements).toHaveLength(0)
})

it('refunds only after a completed lookup has no deliverable image', async () => {
  upstreamBody = { status: 'completed', result: { data: [] } }
  await insertReconciling('empty-result')
  await autoReconcileTasks(now)
  expect(await readTask('empty-result')).toMatchObject({
    status: 'failed',
    error_type: 'upstream_no_image',
  })
  expect(billing.settlements).toEqual([
    expect.objectContaining({ taskId: 'empty-result', outcome: 'failed' }),
  ])
})

it('alerts every task stuck over thirty minutes, once, even when the check batch left it behind', async () => {
  for (let index = 0; index < 6; index++) {
    await insertReconciling(`overdue-${index}`, {
      reconcile_started_at: now - QUEUE_TIMEOUTS.RECONCILE_ALERT_AFTER_MS - index * minute,
      next_retry_at: now - (6 - index) * minute,
      user_id: null,
    })
  }
  await autoReconcileTasks(now)
  expect(sent.map((message) => message.text).sort()).toEqual(
    Array.from(
      { length: 6 },
      (_, index) => `结果确认超过 30 分钟：任务 overdue-${index}，用户 匿名`,
    ).sort(),
  )
  const flagged = await Promise.all(
    Array.from({ length: 6 }, (_, index) => readTask(`overdue-${index}`)),
  )
  expect(flagged.every((row) => row?.reconcile_alerted_at === now)).toBe(true)

  sent.length = 0
  await autoReconcileTasks(now + minute)
  expect(sent).toEqual([])
})

it('retries the thirty-minute alert when the webhook rejects it', async () => {
  failSend = true
  await insertReconciling('alert-retry', {
    reconcile_started_at: now - QUEUE_TIMEOUTS.RECONCILE_ALERT_AFTER_MS,
  })
  await autoReconcileTasks(now)
  expect(sent).toEqual([])
  expect((await readTask('alert-retry'))?.reconcile_alerted_at).toBeNull()

  failSend = false
  await autoReconcileTasks(now + minute)
  expect(sent).toEqual([
    {
      rule: 'reconciling',
      kind: 'firing',
      text: '结果确认超过 30 分钟：任务 alert-retry，用户 匿名',
    },
  ])
  expect((await readTask('alert-retry'))?.reconcile_alerted_at).toBe(now + minute)
})
