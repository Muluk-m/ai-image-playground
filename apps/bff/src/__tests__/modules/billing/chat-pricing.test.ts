import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { creditAccounts, creditLedger, modelPrices, taskHolds } from '@image-playground/db/billing'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'

const TEST_DB = await resetTestDatabase('agent_admin_a298')
const WELCOME = 100_000
const CHAT_MODEL = 'chat-pricing-model'
const IMAGE_MODEL = 'chat-pricing-image-model'
const SERVICE_CREDENTIAL = 'fixture-service-credential-a298'

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'
process.env.INTERNAL_API_TOKEN = SERVICE_CREDENTIAL
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, 'operator-config-chat.json')
process.env.AGENT_CHAT_MODEL = CHAT_MODEL
process.env.WELCOME_CREDITS = String(WELCOME)
const { ensureBillingMigrations } = await import('@image-playground/db')
await ensureBillingMigrations(TEST_DB)

const { _setPrivateBffOverlayForTesting } = await import('../../../lib/private-overlay')
_setPrivateBffOverlayForTesting()
const { app } = await import('../../../app')
const { close: closeDb, db, schema } = await import('../../../db/client')
const { _setChannelsForTesting } = await import('../../../lib/channels')
const { privateTaskHooks } = await import('../../../modules/billing/hooks')
const { ensureChatModelPrice, getChatPricing, syncModelPricesFromChannels, updateModelPrice } =
  await import('../../../modules/billing/pricing')
const { getChatUsageSummary } = await import('../../../modules/billing/queries')

const ALICE = 'a298-alice'
const BOB = 'a298-bob'

async function seedUser(userId: string): Promise<void> {
  const now = Date.now()
  await db.insert(schema.users).values({
    id: userId,
    username: `${userId}-${randomUUID()}`,
    password_hash: 'fixture',
    created_at: now,
    updated_at: now,
  })
}

async function seedTask(taskId: string, model: string): Promise<void> {
  await db.insert(schema.tasks).values({
    id: taskId,
    provider: 'openai-compat',
    model,
    status: 'completed',
    request_payload: { prompt: 'a298 fixture', device_id: 'a298-device' },
    submitted_at: Date.now(),
    upstream_invocation_count: 1,
  })
}

async function priceChatModel(input: {
  inputCredits: number
  outputCredits: number
  reserveTokens: number
}): Promise<void> {
  await updateModelPrice({
    model: CHAT_MODEL,
    creditsPerUnit: input.inputCredits,
    unit: 'kilo_token',
    outputCreditsPerUnit: input.outputCredits,
    outputReserveTokens: input.reserveTokens,
  })
}

async function runChatTurn(input: {
  taskId: string
  userId: string
  reservedMultiplier: number
  usage?: { inputTokens: number; outputTokens: number; multiplier: number }
  outcome?: 'completed' | 'failed'
}): Promise<void> {
  await seedTask(input.taskId, CHAT_MODEL)
  const reserved = await db.transaction((tx) =>
    privateTaskHooks.reserveTask({
      tx,
      taskId: input.taskId,
      userId: input.userId,
      model: CHAT_MODEL,
      quantity: 1,
      unitMultiplier: input.reservedMultiplier,
    }),
  )
  expect(reserved).toMatchObject({ kind: 'reserved' })
  await db.transaction((tx) =>
    privateTaskHooks.finalizeTask({
      tx,
      taskId: input.taskId,
      outcome: input.outcome ?? 'completed',
      upstreamInvocationCount: 1,
      ...(input.usage
        ? {
            actualUsage: {
              quantity: 1,
              unitMultiplier: input.usage.multiplier,
              tokens: { input: input.usage.inputTokens, output: input.usage.outputTokens },
            },
          }
        : {}),
    }),
  )
}

async function jsonReq(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { authorization: `Bearer ${SERVICE_CREDENTIAL}` }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

beforeEach(async () => {
  await db.delete(creditLedger)
  await db.delete(taskHolds)
  await db.delete(creditAccounts)
  await db.delete(schema.tasks)
  await db.delete(schema.operator_audits)
  await db.delete(schema.users)
  await db.delete(modelPrices)
  await seedUser(ALICE)
  await seedUser(BOB)
  await priceChatModel({ inputCredits: 6, outputCredits: 30, reserveTokens: 2_000 })
})

afterAll(async () => {
  await closeDb()
})

describe('对话模型单价', () => {
  it('quotes the price visible inside the caller transaction before commit', async () => {
    await db.transaction(async (tx) => {
      await tx
        .update(modelPrices)
        .set({ output_credits_per_unit: 36 })
        .where(eq(modelPrices.model, CHAT_MODEL))
      const pricing = await privateTaskHooks.chatPricing(CHAT_MODEL, tx)
      expect(pricing?.outputPriceRatio).toBe(6)
      expect(pricing?.quoteCredits?.({ quantity: 1, unitMultiplier: 2 })).toBe(12)
    })
  })

  it('把输入单价、输出单价与输出预留上限存进单价表的同一行', async () => {
    const [row] = await db.select().from(modelPrices).where(eq(modelPrices.model, CHAT_MODEL))
    expect(row).toMatchObject({
      credits_per_image: 6,
      unit: 'kilo_token',
      output_credits_per_unit: 30,
      output_reserve_tokens: 2_000,
      active: true,
    })
  })

  it('写一条运营审计，三个值都在明细里', async () => {
    const audits = await db
      .select()
      .from(schema.operator_audits)
      .where(eq(schema.operator_audits.action, 'billing.model_price.update'))
    expect(audits).toHaveLength(1)
    expect(audits[0]?.target_id).toBe(CHAT_MODEL)
    expect(audits[0]?.details).toMatchObject({
      credits_per_image: 6,
      unit: 'kilo_token',
      output_credits_per_unit: 30,
      output_reserve_tokens: 2_000,
    })
  })

  it('把输出单价折成输出倍数交给公开树', async () => {
    expect(await getChatPricing(CHAT_MODEL)).toMatchObject({
      cachedInputPriceRatio: 0,
      outputPriceRatio: 5,
      outputReserveTokens: 2_000,
    })
    await priceChatModel({ inputCredits: 6, outputCredits: 15, reserveTokens: 4_000 })
    expect(await getChatPricing(CHAT_MODEL)).toMatchObject({
      cachedInputPriceRatio: 0,
      outputPriceRatio: 2.5,
      outputReserveTokens: 4_000,
    })
  })

  it('没有对话定价行时不返回定价', async () => {
    await updateModelPrice({
      model: IMAGE_MODEL,
      creditsPerUnit: 100,
      unit: 'image',
    })
    expect(await getChatPricing(IMAGE_MODEL)).toBeNull()
    expect(await getChatPricing('never-priced')).toBeNull()
  })

  it('对话单价缺了输出侧就拒绝写入', async () => {
    await expect(
      updateModelPrice({
        model: CHAT_MODEL,
        creditsPerUnit: 6,
        unit: 'kilo_token',
      }),
    ).rejects.toThrow('invalid_chat_pricing')
  })

  it('部署起来时给对话模型登记一行默认单价，运营改过的不再覆盖', async () => {
    await db.delete(modelPrices).where(eq(modelPrices.model, CHAT_MODEL))
    await ensureChatModelPrice()
    const [seeded] = await db.select().from(modelPrices).where(eq(modelPrices.model, CHAT_MODEL))
    expect(seeded).toMatchObject({
      credits_per_image: 6,
      unit: 'kilo_token',
      output_credits_per_unit: 30,
      output_reserve_tokens: 2_000,
    })

    await priceChatModel({ inputCredits: 12, outputCredits: 24, reserveTokens: 500 })
    await ensureChatModelPrice()
    expect(await getChatPricing(CHAT_MODEL)).toMatchObject({
      cachedInputPriceRatio: 0,
      outputPriceRatio: 2,
      outputReserveTokens: 500,
    })
  })

  it('channel 同步不把对话那一行的计价单位改回按张', async () => {
    _setChannelsForTesting([
      {
        id: 'gateway',
        kind: 'openai-queue',
        label: 'Gateway',
        baseUrl: 'http://localhost:9999',
        auth: { type: 'bearer', secretRef: 'UPSTREAM_API_KEY', secret: 'test' },
        allowedPaths: ['images/generations'],
        models: [{ id: CHAT_MODEL, label: CHAT_MODEL, media: 'image', capabilities: ['generate'] }],
        defaults: { timeout: 600 },
      },
    ])
    await syncModelPricesFromChannels()
    _setChannelsForTesting([])

    expect(await getChatPricing(CHAT_MODEL)).toMatchObject({
      cachedInputPriceRatio: 0,
      outputPriceRatio: 5,
      outputReserveTokens: 2_000,
    })
  })

  it('改价即时生效，下一轮按新价预扣', async () => {
    await priceChatModel({ inputCredits: 12, outputCredits: 60, reserveTokens: 2_000 })
    await runChatTurn({ taskId: 'a298-after-raise', userId: ALICE, reservedMultiplier: 13 })
    const [hold] = await db
      .select()
      .from(taskHolds)
      .where(eq(taskHolds.task_id, 'a298-after-raise'))
    expect(hold?.credits_per_unit).toBe(12)
    expect(hold?.total_amount).toBe(156)
  })
})

describe('对话 token 消耗汇总', () => {
  it('结算时把上游报的输入与输出 token 落在任务占用上', async () => {
    await runChatTurn({
      taskId: 'a298-tokens',
      userId: ALICE,
      reservedMultiplier: 13,
      usage: { inputTokens: 3_000, outputTokens: 400, multiplier: 5 },
    })
    const [hold] = await db.select().from(taskHolds).where(eq(taskHolds.task_id, 'a298-tokens'))
    expect(hold).toMatchObject({ input_tokens: 3_000, output_tokens: 400, status: 'committed' })
  })

  it('汇总某个用户的输入、输出与折算积分', async () => {
    await runChatTurn({
      taskId: 'a298-alice-1',
      userId: ALICE,
      reservedMultiplier: 13,
      usage: { inputTokens: 3_000, outputTokens: 400, multiplier: 5 },
    })
    await runChatTurn({
      taskId: 'a298-alice-2',
      userId: ALICE,
      reservedMultiplier: 13,
      usage: { inputTokens: 1_000, outputTokens: 200, multiplier: 2 },
    })
    expect(await getChatUsageSummary(ALICE)).toEqual({
      turns: 2,
      input_tokens: 4_000,
      output_tokens: 600,
      credits: 42,
    })
  })

  it('不把生图任务算进对话消耗', async () => {
    await updateModelPrice({
      model: IMAGE_MODEL,
      creditsPerUnit: 100,
      unit: 'image',
    })
    await seedTask('a298-image', IMAGE_MODEL)
    await db.transaction(async (tx) => {
      await privateTaskHooks.reserveTask({
        tx,
        taskId: 'a298-image',
        userId: ALICE,
        model: IMAGE_MODEL,
        quantity: 1,
        unitMultiplier: 1,
      })
      await privateTaskHooks.finalizeTask({
        tx,
        taskId: 'a298-image',
        outcome: 'completed',
        upstreamInvocationCount: 1,
      })
    })
    expect(await getChatUsageSummary(ALICE)).toEqual({
      turns: 0,
      input_tokens: 0,
      output_tokens: 0,
      credits: 0,
    })
  })

  it('不把失败的轮算进消耗', async () => {
    await runChatTurn({
      taskId: 'a298-failed',
      userId: ALICE,
      reservedMultiplier: 13,
      outcome: 'failed',
    })
    expect(await getChatUsageSummary(ALICE)).toEqual({
      turns: 0,
      input_tokens: 0,
      output_tokens: 0,
      credits: 0,
    })
  })

  it('省略用户即全站汇总', async () => {
    await runChatTurn({
      taskId: 'a298-alice-3',
      userId: ALICE,
      reservedMultiplier: 13,
      usage: { inputTokens: 3_000, outputTokens: 400, multiplier: 5 },
    })
    await runChatTurn({
      taskId: 'a298-bob-1',
      userId: BOB,
      reservedMultiplier: 13,
      usage: { inputTokens: 2_000, outputTokens: 200, multiplier: 3 },
    })
    expect(await getChatUsageSummary()).toEqual({
      turns: 2,
      input_tokens: 5_000,
      output_tokens: 600,
      credits: 48,
    })
  })
})

describe('运营接口', () => {
  it('按用户与全站各开一个只读汇总端点', async () => {
    await runChatTurn({
      taskId: 'a298-route',
      userId: ALICE,
      reservedMultiplier: 13,
      usage: { inputTokens: 3_000, outputTokens: 400, multiplier: 5 },
    })
    const site = await jsonReq('GET', '/internal/admin/private/billing/chat-usage')
    expect(site.status).toBe(200)
    expect(site.json).toEqual({ turns: 1, input_tokens: 3_000, output_tokens: 400, credits: 30 })

    const user = await jsonReq('GET', `/internal/admin/private/billing/users/${ALICE}/chat-usage`)
    expect(user.status).toBe(200)
    expect(user.json).toEqual({ turns: 1, input_tokens: 3_000, output_tokens: 400, credits: 30 })
  })

  it('汇总里只有数字，没有会话标题或消息内容', async () => {
    await runChatTurn({
      taskId: 'a298-privacy',
      userId: ALICE,
      reservedMultiplier: 13,
      usage: { inputTokens: 3_000, outputTokens: 400, multiplier: 5 },
    })
    const { json } = await jsonReq('GET', '/internal/admin/private/billing/chat-usage')
    expect(Object.keys(json).sort()).toEqual(['credits', 'input_tokens', 'output_tokens', 'turns'])
    expect(Object.values(json).every((value) => typeof value === 'number')).toBe(true)
  })

  it('运营改对话单价走同一个模型单价端点', async () => {
    const response = await jsonReq('PUT', `/internal/admin/private/billing/models/${CHAT_MODEL}`, {
      credits_per_image: 8,
      active: true,
      unit: 'kilo_token',
      output_credits_per_unit: 40,
      output_reserve_tokens: 3_000,
    })
    expect(response.status).toBe(200)
    expect(await getChatPricing(CHAT_MODEL)).toMatchObject({
      cachedInputPriceRatio: 0,
      outputPriceRatio: 5,
      outputReserveTokens: 3_000,
    })
    const [row] = await db.select().from(modelPrices).where(eq(modelPrices.model, CHAT_MODEL))
    expect(row?.credits_per_image).toBe(8)
  })

  it('目录里带出对话单价的三个值', async () => {
    const { json } = await jsonReq('GET', '/internal/admin/private/billing/catalog')
    const prices = json.model_prices as Array<Record<string, unknown>>
    expect(prices.find((price) => price.model === CHAT_MODEL)).toMatchObject({
      unit: 'kilo_token',
      credits_per_image: 6,
      output_credits_per_unit: 30,
      output_reserve_tokens: 2_000,
    })
  })
})

describe('公开树接缝', () => {
  it('对话定价经任务钩子交给公开树', async () => {
    const pricing = await getChatPricing(CHAT_MODEL)
    expect(pricing).toMatchObject({
      cachedInputPriceRatio: 0,
      outputPriceRatio: 5,
      outputReserveTokens: 2_000,
    })
    expect(
      pricing?.quoteCredits?.(
        { quantity: 1, unitMultiplier: 10 },
        { quantity: 1, unitMultiplier: 4 },
      ),
    ).toBe(24)
    expect(pricing?.quoteCredits?.({ quantity: 1, unitMultiplier: 10 })).toBe(60)
    expect(
      pricing?.quoteCredits?.(
        { quantity: 1, unitMultiplier: 10 },
        { quantity: 1, unitMultiplier: 20 },
      ),
    ).toBe(60)
  })

  it('没有定价行时钩子返回 null，公开树自己兜底', async () => {
    await db.delete(modelPrices).where(eq(modelPrices.model, CHAT_MODEL))
    expect(await privateTaskHooks.chatPricing(CHAT_MODEL)).toBeNull()
  })
})

it('stores audited cache pricing and preserves it when an older admin saves other fields', async () => {
  const update = {
    model: CHAT_MODEL,
    creditsPerUnit: 1,
    unit: 'kilo_token' as const,
    outputCreditsPerUnit: 5,
    outputReserveTokens: 1500,
  }
  await updateModelPrice({ ...update, cachedInputPricePercent: 10 })
  await updateModelPrice(update)
  expect(await getChatPricing(CHAT_MODEL)).toMatchObject({
    cachedInputPriceRatio: 0.1,
    outputPriceRatio: 5,
    outputReserveTokens: 1500,
  })
  const audits = await db
    .select()
    .from(schema.operator_audits)
    .where(eq(schema.operator_audits.action, 'billing.model_price.update'))
  expect(
    audits.some((a) => (a.details as Record<string, unknown>).cached_input_price_percent === 10),
  ).toBe(true)
  for (const value of [-1, 101, 1.5, Number.NaN]) {
    await expect(updateModelPrice({ ...update, cachedInputPricePercent: value })).rejects.toThrow(
      'invalid_cached_input_price',
    )
  }
})

it('refunds the cache discount and persists token details with the settled charge', async () => {
  const { actualChatUsage, reservedChatUsage } = await import('../../../lib/agent/chat-task')
  await updateModelPrice({
    model: CHAT_MODEL,
    creditsPerUnit: 1,
    unit: 'kilo_token',
    outputCreditsPerUnit: 5,
    outputReserveTokens: 1500,
    cachedInputPricePercent: 10,
  })
  const pricing = (await getChatPricing(CHAT_MODEL))!
  const id = randomUUID()
  await seedTask(id, CHAT_MODEL)
  await db.transaction((tx) =>
    privateTaskHooks.reserveTask({
      tx,
      taskId: id,
      userId: ALICE,
      model: CHAT_MODEL,
      ...reservedChatUsage(10000, pricing),
    }),
  )
  const actual = actualChatUsage(
    { inputTokens: 10000, cachedInputTokens: 8000, outputTokens: 1000 },
    pricing,
  )
  // A later price change must not alter the pricing already captured for this turn.
  await updateModelPrice({
    model: CHAT_MODEL,
    creditsPerUnit: 1,
    unit: 'kilo_token',
    outputCreditsPerUnit: 5,
    outputReserveTokens: 1500,
    cachedInputPricePercent: 100,
  })
  const settle = () =>
    db.transaction((tx) =>
      privateTaskHooks.finalizeTask({
        tx,
        taskId: id,
        outcome: 'completed',
        upstreamInvocationCount: 1,
        actualUsage: actual,
      }),
    )
  await settle()
  await settle()
  const [hold] = await db.select().from(taskHolds).where(eq(taskHolds.task_id, id))
  expect(hold).toMatchObject({
    total_amount: 18,
    net_spend: 8,
    input_tokens: 10000,
    cached_input_tokens: 8000,
    output_tokens: 1000,
  })
  const entries = await db.select().from(creditLedger).where(eq(creditLedger.task_id, id))
  expect(
    entries.filter((e) => e.entry_type === 'release').reduce((total, e) => total + e.amount, 0),
  ).toBe(10)
  expect(entries.find((e) => e.entry_type === 'commit')?.metadata).toMatchObject({
    unit_multiplier: 7.8,
    tokens: { input: 10000, cachedInput: 8000, output: 1000 },
  })
})
