import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentTurnUsage } from '@image-playground/shared'
import { installRecordingTaskHooks } from '../../helpers/privateOverlayStub'

process.env.DATABASE_URL = await resetTestDatabase('agent_chat_task')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'

const billing = installRecordingTaskHooks()

const { chatTaskPricing, reserveChatTask } = await import('../../../lib/agent/chat-task')
const { _setPrivateBffOverlayForTesting, loadPrivateBffOverlay } = await import(
  '../../../lib/private-overlay'
)
const { close: closeDb, db, schema } = await import('../../../db/client')

type ChatPricing = import('../../../lib/private-overlay').ChatPricing
type ChatTaskReserved = import('../../../lib/agent/chat-task').ChatTaskReserved

const USER_ID = 'chat-task-user'
const CONVERSATION = 'conversation-chat-task'
const DEVICE = 'device-abcdefgh'
const MODEL = 'fixture-agent-model'
const CACHED_PRICING: ChatPricing = {
  outputPriceRatio: 5,
  outputReserveTokens: 1_500,
  cachedInputPriceRatio: 0.1,
}

/** 私有钩子的算法：单价 × 数量 × 倍率后向上取整。整张单价表只有正整数。 */
function credits(creditsPerUnit: number, usage: { quantity: number; unitMultiplier: number }) {
  return Math.ceil(creditsPerUnit * usage.quantity * usage.unitMultiplier)
}

let nextTurn = 0

/** 走一次真预扣：定价快照、任务行与预扣都由被测模块自己安排。 */
async function reserve(input: {
  estimatedInputTokens: number
  /** 运营配的单价；缺席即单价表没登记这个模型，由模块兜底。 */
  pricing?: ChatPricing
}) {
  billing.pricing = input.pricing ?? null
  const taskHooks = (await loadPrivateBffOverlay()).taskHooks
  const pricing = await chatTaskPricing(taskHooks, MODEL)
  nextTurn += 1
  const turnId = `turn-${nextTurn}`
  const reservation = await db.transaction((tx) =>
    reserveChatTask({
      tx,
      taskHooks,
      conversationId: CONVERSATION,
      turnId,
      userId: USER_ID,
      deviceId: DEVICE,
      model: MODEL,
      estimatedInputTokens: input.estimatedInputTokens,
      pricing,
    }),
  )
  return { turnId, reservation }
}

/** 预扣记到钩子上的计价用量，就是私有账本据以扣费的那一份。 */
function reserved() {
  const last = billing.reservations.at(-1)
  if (!last) throw new Error('expected a recorded reservation')
  return last
}

/** 结算一轮，回报钩子收到的实际用量（缺席即按预留全额结算）。 */
async function settleTurn(
  reservation: ChatTaskReserved,
  usage: AgentTurnUsage | null,
  outcome: 'completed' | 'failed' = 'completed',
) {
  const cost = await reservation.settle({ outcome, usage, upstreamInvocationCount: 2 })
  const last = billing.settlements.at(-1)
  if (!last) throw new Error('expected a recorded settlement')
  return { cost, settlement: last }
}

const VIDEO_PAYLOAD = {
  prompt: '海浪拍打礁石',
  device_id: DEVICE,
  video: { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' },
} as const satisfies (typeof schema.tasks.$inferInsert)['request_payload']

/** 工具提交的任务：各自独立计费，只用会话与轮关联。 */
function toolTask(id: string, turnId: string): typeof schema.tasks.$inferInsert {
  return {
    id,
    kind: 'queue',
    provider: 'openai-compat',
    model: 'fixture-image-model',
    status: 'completed',
    request_payload: { prompt: '一只橘猫', device_id: DEVICE },
    submitted_at: Date.now(),
    user_id: USER_ID,
    agent_conversation_id: CONVERSATION,
    agent_turn_id: turnId,
  }
}

function expectReserved(reservation: Awaited<ReturnType<typeof reserve>>['reservation']) {
  if (reservation.kind !== 'reserved') {
    throw new Error(`expected a reservation, got ${reservation.kind}`)
  }
  return reservation
}

beforeEach(async () => {
  billing.reset()
  await db.delete(schema.tasks)
  await db.delete(schema.users)
  const now = Date.now()
  await db.insert(schema.users).values({
    id: USER_ID,
    username: 'chat.task',
    password_hash: 'hash',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
})

afterAll(async () => {
  _setPrivateBffOverlayForTesting()
  await closeDb()
})

describe('reserveChatTask', () => {
  it('reserves the estimated input plus the whole output ceiling', async () => {
    const { turnId } = await reserve({ estimatedInputTokens: 3_000 })

    expect(reserved()).toEqual({
      taskId: turnId,
      userId: USER_ID,
      model: MODEL,
      quantity: 1,
      unitMultiplier: 13,
    })
  })

  it('turns a unit price of 6 into 6 per thousand input and 30 per thousand output', async () => {
    await reserve({ estimatedInputTokens: 3_000 })

    expect(credits(6, reserved())).toBe(18 + 60)
  })

  it('follows the operator-configured output price and reserve', async () => {
    await reserve({
      estimatedInputTokens: 3_000,
      pricing: { outputPriceRatio: 4, outputReserveTokens: 500 },
    })

    expect(reserved()).toMatchObject({ quantity: 1, unitMultiplier: 5 })
  })

  it('reserves ordinary input price because cache hits are unknown before the request', async () => {
    await reserve({ estimatedInputTokens: 10_000, pricing: CACHED_PRICING })

    expect(reserved().unitMultiplier).toBe(17.5)
  })

  it('lands a chat task row that the worker never claims and that keeps the prompt out', async () => {
    billing.answer = { kind: 'reserved', credits: 60 }

    const { turnId, reservation } = await reserve({ estimatedInputTokens: 3_000 })

    expect(expectReserved(reservation).reservedCredits).toBe(60)
    const [task] = await db.select().from(schema.tasks)
    expect(task).toMatchObject({
      id: turnId,
      kind: 'chat',
      status: 'in_progress',
      user_id: USER_ID,
      device_id: DEVICE,
      agent_conversation_id: CONVERSATION,
      agent_turn_id: turnId,
    })
    // worker 只 claim queued；这一行它永远捞不走。
    expect(task!.status).not.toBe('queued')
    expect(task!.request_payload.prompt).toBe('')
  })

  it('hands the refusal back and leaves no task row behind', async () => {
    billing.answer = { kind: 'insufficient_credits', required: 78, available: 12 }

    const { reservation } = await reserve({ estimatedInputTokens: 3_000 })

    expect(reservation).toEqual({ kind: 'insufficient_credits', required: 78, available: 12 })
    expect(await db.select().from(schema.tasks)).toEqual([])
  })

  it('refuses the turn when the price table does not know the model', async () => {
    billing.answer = { kind: 'price_unavailable', model: MODEL }

    const { reservation } = await reserve({ estimatedInputTokens: 3_000 })

    expect(reservation).toEqual({ kind: 'price_unavailable', model: MODEL })
    expect(await db.select().from(schema.tasks)).toEqual([])
  })
})

describe('settling a chat task', () => {
  it('prices what the gateway reported at the same two rates', async () => {
    const { reservation } = await reserve({ estimatedInputTokens: 3_000 })

    const { settlement } = await settleTurn(expectReserved(reservation), {
      inputTokens: 2_000,
      outputTokens: 400,
    })

    expect(settlement).toMatchObject({
      outcome: 'completed',
      upstreamInvocationCount: 2,
      actualUsage: { quantity: 1, unitMultiplier: 4, tokens: { input: 2_000, output: 400 } },
    })
    expect(credits(6, settlement.actualUsage!)).toBe(12 + 12)
  })

  it('rounds a sub-credit turn up to one credit', async () => {
    const { reservation } = await reserve({ estimatedInputTokens: 3_000 })

    const { settlement } = await settleTurn(expectReserved(reservation), {
      inputTokens: 1,
      outputTokens: 1,
    })

    expect(credits(6, settlement.actualUsage!)).toBe(1)
  })

  it('settles at the snapshot taken when the turn started, not at a later price', async () => {
    const { reservation } = await reserve({
      estimatedInputTokens: 3_000,
      pricing: { outputPriceRatio: 4, outputReserveTokens: 500 },
    })
    // 运营在途中改价：这一轮的账不跟着改。
    billing.pricing = { outputPriceRatio: 40, outputReserveTokens: 500 }

    const { settlement } = await settleTurn(expectReserved(reservation), {
      inputTokens: 2_000,
      outputTokens: 400,
    })

    expect(settlement.actualUsage).toMatchObject({ quantity: 1, unitMultiplier: 3.6 })
  })

  it('charges cached input once at one tenth, then rounds the whole turn once', async () => {
    const { reservation } = await reserve({
      estimatedInputTokens: 10_000,
      pricing: CACHED_PRICING,
    })

    const { settlement } = await settleTurn(expectReserved(reservation), {
      inputTokens: 10_000,
      cachedInputTokens: 8_000,
      outputTokens: 1_000,
    })

    expect(settlement.actualUsage!.unitMultiplier).toBeCloseTo(7.8)
    expect(settlement.actualUsage!.tokens).toEqual({
      input: 10_000,
      cachedInput: 8_000,
      output: 1_000,
    })
    expect(credits(1, settlement.actualUsage!)).toBe(8)
  })

  it('settles fully cached input without treating the call as missing usage', async () => {
    const { reservation } = await reserve({
      estimatedInputTokens: 10_000,
      pricing: CACHED_PRICING,
    })

    const { settlement } = await settleTurn(expectReserved(reservation), {
      inputTokens: 10_000,
      cachedInputTokens: 10_000,
      outputTokens: 0,
    })

    expect(credits(1, settlement.actualUsage!)).toBe(1)
  })

  it('keeps cache reads free until the private overlay configures their rate', async () => {
    const { reservation } = await reserve({ estimatedInputTokens: 10_000 })

    const { settlement } = await settleTurn(expectReserved(reservation), {
      inputTokens: 10_000,
      cachedInputTokens: 10_000,
      outputTokens: 0,
    })

    expect(settlement.actualUsage!.unitMultiplier).toBe(0)
  })

  it('leaves the actual usage out when the gateway reported none, settling the reserve in full', async () => {
    const { turnId, reservation } = await reserve({ estimatedInputTokens: 3_000 })

    const { settlement } = await settleTurn(expectReserved(reservation), null)

    expect(settlement).toMatchObject({ taskId: turnId, outcome: 'completed' })
    expect(settlement.actualUsage).toBeUndefined()
    const [task] = await db.select().from(schema.tasks)
    expect(task).toMatchObject({ status: 'completed', upstream_invocation_count: 2 })
  })

  it('collects the chat credits together with this turn own image and video tasks', async () => {
    billing.settledCredits = 42
    billing.creditsPerTask = 85
    const { turnId, reservation } = await reserve({ estimatedInputTokens: 3_000 })
    await db.insert(schema.tasks).values([
      toolTask(`${turnId}-image`, turnId),
      { ...toolTask(`${turnId}-video`, turnId), request_payload: VIDEO_PAYLOAD },
      // 别的轮的任务不进这一轮的账。
      toolTask(`${turnId}-other`, 'turn-elsewhere'),
    ])

    const { cost } = await settleTurn(expectReserved(reservation), {
      inputTokens: 2_000,
      outputTokens: 400,
    })

    expect(cost).toEqual({ chat: 42, image: 85, video: 85 })
  })

  it('costs a failed turn nothing once the ledger has refunded it', async () => {
    billing.settledCredits = 42
    const { reservation } = await reserve({ estimatedInputTokens: 3_000 })

    const { cost, settlement } = await settleTurn(expectReserved(reservation), null, 'failed')

    expect(settlement.outcome).toBe('failed')
    expect(cost).toEqual({ chat: 0, image: 0, video: 0 })
  })
})
