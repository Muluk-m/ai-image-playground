import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'

const TEST_DB = await resetTestDatabase('bff_task_transitions')

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../quota-operator-config.json')

const { app } = await import('../../app')
const { close: closeDb, db, schema } = await import('../../db/client')
const { finishTask, heldBy } = await import('../../db/task-transitions')
const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../lib/private-overlay'
)
type PrivateBffOverlay = import('../../lib/private-overlay').PrivateBffOverlay
type PrivateTaskHooks = import('../../lib/private-overlay').PrivateTaskHooks
type TaskStatus = (typeof schema.tasks.$inferInsert)['status']
const SETTLEMENT_TOKEN = 'settlement-test-worker'

type SettlementCall = {
  taskId: string
  outcome: string
  upstreamInvocationCount: number
  errorType: string | null
  upstreamStatus: number | null
  actualUsage: { quantity: number; unitMultiplier: number } | null
}

let settlements: SettlementCall[]

function trackingOverlay(): PrivateBffOverlay {
  return Object.freeze({
    ...EMPTY_PRIVATE_BFF_OVERLAY,
    present: true,
    taskHooks: {
      ...EMPTY_PRIVATE_BFF_OVERLAY.taskHooks,
      async finalizeTask(input: Parameters<PrivateTaskHooks['finalizeTask']>[0]) {
        settlements.push({
          taskId: input.taskId,
          outcome: input.outcome,
          upstreamInvocationCount: input.upstreamInvocationCount,
          errorType: input.errorType ?? null,
          upstreamStatus: input.upstreamStatus ?? null,
          actualUsage: input.actualUsage ?? null,
        })
      },
    },
  })
}

async function insertTask(
  id: string,
  status: TaskStatus,
  upstreamInvocationCount = 0,
  meteringMode: 'none' | 'credits' | null = null,
) {
  await db.insert(schema.tasks).values({
    id,
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status,
    ...(meteringMode
      ? { metering: { mode: meteringMode, model: 'gpt-image-2', quantity: 1, unitMultiplier: 1 } }
      : {}),
    ...(status === 'in_progress'
      ? { execution_token: SETTLEMENT_TOKEN, lease_expires_at: Date.now() + 60_000 }
      : {}),
    request_payload: { prompt: 'settlement fixture', device_id: 'settle-device' },
    submitted_at: Date.now(),
    upstream_invocation_count: upstreamInvocationCount,
  })
}

beforeEach(async () => {
  settlements = []
  _setPrivateBffOverlayForTesting(trackingOverlay())
  await db.delete(schema.tasks)
})

afterEach(() => {
  _setPrivateBffOverlayForTesting()
})

afterAll(async () => {
  await closeDb()
})

describe('task settlement hook', () => {
  it('reports a completed outcome for a task that delivered images', async () => {
    await insertTask('settle-completed', 'in_progress', 1)

    const written = await finishTask(
      'settle-completed',
      {
        status: 'completed',
        resultPayload: { data: [{ url: 'https://example.invalid/image.png' }] },
        completedAt: Date.now(),
      },
      heldBy(SETTLEMENT_TOKEN),
    )

    expect(written).toBe(true)
    expect(settlements).toEqual([
      {
        taskId: 'settle-completed',
        outcome: 'completed',
        upstreamInvocationCount: 1,
        errorType: null,
        upstreamStatus: null,
        actualUsage: null,
      },
    ])
  })

  it('reports a failed outcome with the failure summary even after upstream ran', async () => {
    await insertTask('settle-failed', 'in_progress', 2)

    const written = await finishTask(
      'settle-failed',
      {
        status: 'failed',
        errorMessage: 'upstream rejected the prompt',
        errorType: 'upstream_error',
        upstreamStatus: 403,
        upstreamBody: '{\"error\":\"content policy\"}',
        completedAt: Date.now(),
      },
      heldBy(SETTLEMENT_TOKEN),
    )

    expect(written).toBe(true)
    expect(settlements).toEqual([
      {
        taskId: 'settle-failed',
        outcome: 'failed',
        upstreamInvocationCount: 2,
        errorType: 'upstream_error',
        upstreamStatus: 403,
        actualUsage: null,
      },
    ])
  })

  it('reports a cancelled outcome from the cancel route', async () => {
    await insertTask('settle-cancelled', 'in_progress', 1)

    const response = await app.handle(
      new Request('http://localhost/v1/queue/requests/settle-cancelled/cancel', { method: 'PUT' }),
    )

    expect(response.status).toBe(200)
    expect(settlements).toEqual([
      {
        taskId: 'settle-cancelled',
        outcome: 'cancelled',
        upstreamInvocationCount: 1,
        errorType: null,
        upstreamStatus: null,
        actualUsage: null,
      },
    ])
  })

  it('hands the settlement hook the actual usage a task reported', async () => {
    await insertTask('settle-metered', 'in_progress', 1)

    const written = await finishTask(
      'settle-metered',
      {
        status: 'completed',
        resultPayload: { data: [{ url: 'https://example.invalid/image.png' }] },
        completedAt: Date.now(),
        actualUsage: { quantity: 1, unitMultiplier: 3.5 },
      },
      heldBy(SETTLEMENT_TOKEN),
    )

    expect(written).toBe(true)
    expect(settlements).toEqual([
      {
        taskId: 'settle-metered',
        outcome: 'completed',
        upstreamInvocationCount: 1,
        errorType: null,
        upstreamStatus: null,
        actualUsage: { quantity: 1, unitMultiplier: 3.5 },
      },
    ])
  })
})

describe('metering snapshot terminal behavior', () => {
  it('keeps an unmetered task completed without calling financial settlement', async () => {
    await insertTask('none-completed', 'in_progress', 1, 'none')
    expect(
      await finishTask(
        'none-completed',
        {
          status: 'completed',
          resultPayload: { data: [{ url: 'https://example.invalid/free.png' }] },
          completedAt: 1234,
        },
        heldBy(SETTLEMENT_TOKEN),
      ),
    ).toBe(true)
    const [task] = await db.select().from(schema.tasks)
    expect(task).toMatchObject({
      id: 'none-completed',
      status: 'completed',
      metering: { mode: 'none' },
    })
    expect(task?.result_payload).toEqual({ data: [{ url: 'https://example.invalid/free.png' }] })
    expect(task?.completed_at).toBe(1234)
    expect(settlements).toHaveLength(0)
  })

  it('keeps an unmetered failed task terminal without calling financial settlement', async () => {
    await insertTask('none-failed', 'in_progress', 1, 'none')
    expect(
      await finishTask(
        'none-failed',
        {
          status: 'failed',
          errorMessage: 'free upstream failure',
          errorType: 'upstream_error',
          completedAt: 2345,
        },
        heldBy(SETTLEMENT_TOKEN),
      ),
    ).toBe(true)
    const [task] = await db.select().from(schema.tasks)
    expect(task).toMatchObject({ id: 'none-failed', status: 'failed', metering: { mode: 'none' } })
    expect(task?.error_message).toBe('free upstream failure')
    expect(task?.completed_at).toBe(2345)
    expect(settlements).toHaveLength(0)
  })

  it('keeps an unmetered cancelled task terminal without calling financial settlement', async () => {
    await insertTask('none-cancelled', 'in_progress', 1, 'none')
    const response = await app.handle(
      new Request('http://localhost/v1/queue/requests/none-cancelled/cancel', { method: 'PUT' }),
    )
    expect(response.status).toBe(200)
    const [task] = await db.select().from(schema.tasks)
    expect(task).toMatchObject({
      id: 'none-cancelled',
      status: 'cancelled',
      metering: { mode: 'none' },
    })
    expect(task?.completed_at).toEqual(expect.any(Number))
    expect(settlements).toHaveLength(0)
  })

  it('settles both explicit credits and legacy null metering snapshots', async () => {
    await insertTask('credits-terminal', 'in_progress', 1, 'credits')
    await insertTask('legacy-terminal', 'in_progress', 1)
    expect(
      await finishTask(
        'credits-terminal',
        { status: 'completed', resultPayload: { data: [] }, completedAt: 3456 },
        heldBy(SETTLEMENT_TOKEN),
      ),
    ).toBe(true)
    expect(
      await finishTask(
        'legacy-terminal',
        { status: 'failed', errorMessage: 'legacy failure', completedAt: 4567 },
        heldBy(SETTLEMENT_TOKEN),
      ),
    ).toBe(true)
    expect(settlements.map(({ taskId, outcome }) => ({ taskId, outcome }))).toEqual([
      { taskId: 'credits-terminal', outcome: 'completed' },
      { taskId: 'legacy-terminal', outcome: 'failed' },
    ])
    const rows = await db.select().from(schema.tasks)
    expect(rows.find((row) => row.id === 'credits-terminal')).toMatchObject({ status: 'completed' })
    expect(rows.find((row) => row.id === 'legacy-terminal')).toMatchObject({ status: 'failed' })
  })

  it('does not settle a terminal task twice', async () => {
    await insertTask('terminal-once', 'in_progress', 1, 'credits')
    const update = {
      status: 'completed' as const,
      resultPayload: { data: [] },
      completedAt: 5678,
    }
    expect(await finishTask('terminal-once', update, heldBy(SETTLEMENT_TOKEN))).toBe(true)
    expect(await finishTask('terminal-once', update, heldBy(SETTLEMENT_TOKEN))).toBe(false)
    const [task] = await db.select().from(schema.tasks)
    expect(task).toMatchObject({ id: 'terminal-once', status: 'completed' })
    expect(settlements).toHaveLength(1)
  })
})
