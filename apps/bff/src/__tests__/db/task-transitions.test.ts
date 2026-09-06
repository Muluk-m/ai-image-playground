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
const { finishTask } = await import('../../db/task-transitions')
const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../lib/private-overlay'
)
type PrivateBffOverlay = Awaited<ReturnType<typeof import('../../lib/private-overlay')>>

type SettlementCall = {
  taskId: string
  outcome: string
  upstreamInvocationCount: number
  errorType: string | null
  upstreamStatus: number | null
}

let settlements: SettlementCall[]

function trackingOverlay() {
  return Object.freeze({
    ...EMPTY_PRIVATE_BFF_OVERLAY,
    present: true,
    taskHooks: {
      ...EMPTY_PRIVATE_BFF_OVERLAY.taskHooks,
      async finalizeTask(input: {
        taskId: string
        outcome: string
        upstreamInvocationCount: number
        errorType?: string | null
        upstreamStatus?: number | null
      }) {
        settlements.push({
          taskId: input.taskId,
          outcome: input.outcome,
          upstreamInvocationCount: input.upstreamInvocationCount,
          errorType: input.errorType ?? null,
          upstreamStatus: input.upstreamStatus ?? null,
        })
      },
    },
  })
}

async function insertTask(id: string, status: string, upstreamInvocationCount = 0) {
  await db.insert(schema.tasks).values({
    id,
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status,
    request_payload: { prompt: 'settlement fixture', device_id: 'settle-device' },
    submitted_at: Date.now(),
    upstream_invocation_count: upstreamInvocationCount,
  })
}

beforeEach(async () => {
  settlements = []
  _setPrivateBffOverlayForTesting(trackingOverlay() as unknown as PrivateBffOverlay)
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

    const written = await finishTask('settle-completed', {
      status: 'completed',
      resultPayload: { data: [{ url: 'https://example.invalid/image.png' }] },
      completedAt: Date.now(),
    })

    expect(written).toBe(true)
    expect(settlements).toEqual([
      {
        taskId: 'settle-completed',
        outcome: 'completed',
        upstreamInvocationCount: 1,
        errorType: null,
        upstreamStatus: null,
      },
    ])
  })

  it('reports a failed outcome with the failure summary even after upstream ran', async () => {
    await insertTask('settle-failed', 'in_progress', 2)

    const written = await finishTask('settle-failed', {
      status: 'failed',
      errorMessage: 'upstream rejected the prompt',
      errorType: 'upstream_error',
      upstreamStatus: 403,
      upstreamBody: '{"error":"content policy"}',
      completedAt: Date.now(),
    })

    expect(written).toBe(true)
    expect(settlements).toEqual([
      {
        taskId: 'settle-failed',
        outcome: 'failed',
        upstreamInvocationCount: 2,
        errorType: 'upstream_error',
        upstreamStatus: 403,
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
      },
    ])
  })
})
