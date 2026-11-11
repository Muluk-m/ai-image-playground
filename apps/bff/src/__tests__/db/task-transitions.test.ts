import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { queueTask } from '@image-playground/shared'
import { eq } from 'drizzle-orm'

const TEST_DB = await resetTestDatabase('bff_task_transitions')

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../quota-operator-config.json')

const { app } = await import('../../app')
const { close: closeDb, db, schema } = await import('../../db/client')
const { cancelTasks, finishTask, gptSettledUsage, heldBy } = await import(
  '../../db/task-transitions'
)
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

describe('gptSettledUsage', () => {
  const premium = { size: '2048x2048', quality: 'high', n: 2 }
  const completed = { status: 'completed' as const, completedAt: 0 }

  it('settles a premium GPT order that ran on sub2api at the basic rate', () => {
    expect(
      gptSettledUsage(completed, {
        model: 'gpt-image-2.5-flare',
        request: premium,
        gptRoute: 'sub2api',
      }),
    ).toEqual({ quantity: 2, unitMultiplier: 1 })
    // 部分出图已经按交付张数给了用量：张数沿用，只把倍率改回 1。
    expect(
      gptSettledUsage(
        { ...completed, actualUsage: { quantity: 1, unitMultiplier: 8 } },
        { model: 'gpt-image-2.5-flare', request: premium, gptRoute: 'sub2api' },
      ),
    ).toEqual({ quantity: 1, unitMultiplier: 1 })
    // 非会员的 2K 不是 sub2api 能兑现的档：落到 sub2api 同样按倍率 1 退差价。
    expect(
      gptSettledUsage(completed, {
        model: 'gpt-image-2.5-flare',
        request: { size: '2048x2048', quality: 'medium', n: 1 },
        gptRoute: 'sub2api',
      }),
    ).toEqual({ quantity: 1, unitMultiplier: 1 })
    // 2.6 落到 sub2api 时按降级后的 1K medium 倍率退差价，不按 2.5 的 1 倍。
    expect(
      gptSettledUsage(completed, {
        model: 'gpt-image-2.6-flare',
        request: { ...premium, output_format: 'png' },
        gptRoute: 'sub2api',
      }),
    ).toEqual({ quantity: 2, unitMultiplier: 3.3 })
    // 崩溃恢复不改落库正文。GIF 高画质收到 1K medium；低画质 SVG 只改格式和尺寸，画质仍是 low。
    expect(
      gptSettledUsage(completed, {
        model: 'gpt-image-2.6-flare',
        request: {
          size: '2048x2048',
          quality: 'high',
          output_format: 'gif',
          frame_count: 12,
          n: 1,
        },
        gptRoute: 'sub2api',
      }),
    ).toEqual({ quantity: 1, unitMultiplier: 3.3 })
    expect(
      gptSettledUsage(completed, {
        model: 'gpt-image-2.6-flare',
        request: { output_format: 'svg', quality: 'low', n: 1 },
        gptRoute: 'sub2api',
      }),
    ).toEqual({ quantity: 1, unitMultiplier: 1.9 })
  })

  it('keeps the frozen settlement when the order ran direct, was basic, failed or is another model', () => {
    const usage = { quantity: 1, unitMultiplier: 8 }
    const update = { ...completed, actualUsage: usage }
    const flare = { model: 'gpt-image-2.5-flare', request: premium }
    expect(gptSettledUsage(update, { ...flare, gptRoute: 'direct' })).toBe(usage)
    expect(gptSettledUsage(update, { ...flare, gptRoute: null })).toBe(usage)
    expect(
      gptSettledUsage(update, { ...flare, request: { size: '1024x1024' }, gptRoute: 'sub2api' }),
    ).toBe(usage)
    expect(
      gptSettledUsage({ ...update, status: 'failed' }, { ...flare, gptRoute: 'sub2api' }),
    ).toBe(usage)
    expect(
      gptSettledUsage(update, { ...flare, model: 'gemini-3-pro-image', gptRoute: 'sub2api' }),
    ).toBe(usage)
  })
})

describe('queueTask 终态与结算口径', () => {
  const usage = { quantity: 1, unitMultiplier: 3.5 }

  it('succeed / fail / cancel 的目的地与转移表一致', () => {
    expect(queueTask.target('succeed')).toBe('completed')
    expect(queueTask.target('fail')).toBe('failed')
    expect(queueTask.target('cancel')).toBe('cancelled')
    expect(queueTask.allows('in_progress', 'succeed')).toBe(true)
    expect(queueTask.allows('in_progress', 'fail')).toBe(true)
    expect(queueTask.allows('in_progress', 'cancel')).toBe(true)
    expect(queueTask.allows('queued', 'cancel')).toBe(true)
    expect(queueTask.allows('reconciling', 'succeed')).toBe(true)
    expect(queueTask.allows('reconciling', 'fail')).toBe(true)
    expect(queueTask.allows('reconciling', 'cancel')).toBe(true)
  })

  it('每条终态路径的结算 hook 与改前口径相同（扣费/退款决定只看 outcome 与用量）', async () => {
    const paths = [
      {
        id: 'term-completed',
        from: 'in_progress' as const,
        run: () =>
          finishTask(
            'term-completed',
            {
              status: 'completed',
              resultPayload: { data: [{ url: 'https://example.invalid/ok.png' }] },
              completedAt: 11,
              actualUsage: usage,
            },
            heldBy(SETTLEMENT_TOKEN),
          ),
        status: 'completed' as const,
        settlement: {
          outcome: 'completed',
          upstreamInvocationCount: 1,
          errorType: null,
          upstreamStatus: null,
          actualUsage: usage,
        },
      },
      {
        id: 'term-failed',
        from: 'in_progress' as const,
        run: () =>
          finishTask(
            'term-failed',
            {
              status: 'failed',
              errorMessage: 'upstream rejected',
              errorType: 'upstream_error' as const,
              upstreamStatus: 403,
              completedAt: 22,
            },
            heldBy(SETTLEMENT_TOKEN),
          ),
        status: 'failed' as const,
        settlement: {
          outcome: 'failed',
          upstreamInvocationCount: 1,
          errorType: 'upstream_error',
          upstreamStatus: 403,
          actualUsage: null,
        },
      },
      {
        id: 'term-finish-cancelled',
        from: 'in_progress' as const,
        run: () =>
          finishTask(
            'term-finish-cancelled',
            { status: 'cancelled', completedAt: 33 },
            heldBy(SETTLEMENT_TOKEN),
          ),
        status: 'cancelled' as const,
        settlement: {
          outcome: 'cancelled',
          upstreamInvocationCount: 1,
          errorType: null,
          upstreamStatus: null,
          actualUsage: null,
        },
      },
      {
        id: 'term-cancel-running',
        from: 'in_progress' as const,
        run: () => cancelTasks(eq(schema.tasks.id, 'term-cancel-running')),
        status: 'cancelled' as const,
        settlement: {
          outcome: 'cancelled',
          upstreamInvocationCount: 1,
          errorType: null,
          upstreamStatus: null,
          actualUsage: null,
        },
      },
      {
        id: 'term-cancel-queued',
        from: 'queued' as const,
        run: () => cancelTasks(eq(schema.tasks.id, 'term-cancel-queued')),
        status: 'cancelled' as const,
        settlement: {
          outcome: 'cancelled',
          upstreamInvocationCount: 1,
          errorType: null,
          upstreamStatus: null,
          actualUsage: null,
        },
      },
    ]

    for (const path of paths) {
      settlements = []
      await db.delete(schema.tasks)
      await insertTask(path.id, path.from, 1, 'credits')
      await path.run()
      const [task] = await db.select().from(schema.tasks)
      expect(task?.status, path.id).toBe(path.status)
      expect(settlements, path.id).toEqual([{ taskId: path.id, ...path.settlement }])
    }
  })

  it('mode=none 的终态不调用结算 hook', async () => {
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      settlements = []
      await db.delete(schema.tasks)
      await insertTask(`none-${status}`, 'in_progress', 1, 'none')
      await finishTask(
        `none-${status}`,
        status === 'completed'
          ? { status, resultPayload: { data: [] }, completedAt: 1 }
          : status === 'failed'
            ? { status, errorMessage: 'free fail', completedAt: 1 }
            : { status, completedAt: 1 },
        heldBy(SETTLEMENT_TOKEN),
      )
      expect(settlements, status).toEqual([])
      const [task] = await db.select().from(schema.tasks)
      expect(task?.status).toBe(status)
    }
  })
})
