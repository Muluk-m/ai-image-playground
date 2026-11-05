import { randomUUID } from 'node:crypto'
import { imageSizeTier } from '@image-playground/shared'
import { and, eq, gte, isNull, or, sql } from 'drizzle-orm'
import { config } from '../../config'
import { db, schema } from '../../db/client'
import { log } from '../logger'
import { configuredDirectKeys } from './gpt-key-config'

/**
 * OpenAI 直连的月预算：每条请求按上游回报的 token 折算成本落库，并记到具体那把 key。
 * 一把 key 本月累计加上这次的预估超过它自己的「月预算 × 封顶比例」就换下一把。
 * 只配一把 `OPENAI_API_KEY` 时，空指纹的旧行也算进这把，和以前的整月累计一样。
 * 月按台北时间的自然月算。
 */

const BUDGET_TIME_ZONE = 'Asia/Taipei'
/** 本月累计在进程里缓存这么久；封顶附近会多放几张，量级在几美分。 */
const SPENT_CACHE_MS = 30_000

/** 2026-10-31 直连实测每张输出 token（flare 与 sunburst 相同），用于拿不到 usage 时估算。 */
const OUTPUT_TOKENS_PER_IMAGE = {
  '1K': { low: 196, medium: 439, high: 1756 },
  '2K': { low: 397, medium: 892, high: 3568 },
  '4K': { low: 371, medium: 865, high: 3336 },
} as const

export interface DirectUsage {
  readonly inputTextTokens: number
  readonly inputImageTokens: number
  readonly outputTokens: number
}

function qualityLevel(quality: string | undefined): 'low' | 'medium' | 'high' {
  return quality === 'low' || quality === 'high' ? quality : 'medium'
}

export function directCostMicroUsd(usage: DirectUsage): number {
  const gpt = config.gptDirect
  return Math.ceil(
    usage.inputTextTokens * gpt.priceInputTextPerMillion +
      usage.inputImageTokens * gpt.priceInputImagePerMillion +
      usage.outputTokens * gpt.priceOutputPerMillion,
  )
}

/** 没有 usage 时按档位估一张图的成本（只算输出，输入 token 在一张图里不到 1%）。 */
export function estimateDirectCostMicroUsd(
  size: string | undefined,
  quality: string | undefined,
  images: number,
): number {
  const tokens = OUTPUT_TOKENS_PER_IMAGE[imageSizeTier(size)][qualityLevel(quality)]
  return directCostMicroUsd({
    inputTextTokens: 0,
    inputImageTokens: 0,
    outputTokens: tokens * images,
  })
}

/** 从 OpenAI Images 响应里读 usage；没有或形状不对返回 null。 */
export function readDirectUsage(payload: unknown): DirectUsage | null {
  if (!payload || typeof payload !== 'object') return null
  const usage = (payload as { usage?: unknown }).usage
  if (!usage || typeof usage !== 'object') return null
  const u = usage as {
    input_tokens?: unknown
    output_tokens?: unknown
    input_tokens_details?: { image_tokens?: unknown; text_tokens?: unknown }
  }
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  if (typeof u.output_tokens !== 'number') return null
  const inputImage = num(u.input_tokens_details?.image_tokens)
  const inputText =
    u.input_tokens_details?.text_tokens !== undefined
      ? num(u.input_tokens_details.text_tokens)
      : Math.max(0, num(u.input_tokens) - inputImage)
  return { inputTextTokens: inputText, inputImageTokens: inputImage, outputTokens: u.output_tokens }
}

/** 台北时间本月 1 日 0 点的 epoch 毫秒。 */
export function budgetMonthStart(now: number): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUDGET_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now)
  const year = parts.find((part) => part.type === 'year')!.value
  const month = parts.find((part) => part.type === 'month')!.value
  // 台北没有夏令时，固定 UTC+8。
  return Date.parse(`${year}-${month}-01T00:00:00+08:00`)
}

export function keyBudgetCapMicroUsd(budgetUsd: number): number {
  return Math.floor((budgetUsd * 1_000_000 * config.gptDirect.budgetPercent) / 100)
}

/** 各把密钥的封顶之和。只配一把时就是原来的那一个封顶。 */
export function directBudgetCapMicroUsd(): number {
  const keys = configuredDirectKeys()
  if (keys.length === 0) return keyBudgetCapMicroUsd(config.gptDirect.monthlyBudgetUsd)
  return keys.reduce((sum, key) => sum + keyBudgetCapMicroUsd(key.budgetUsd), 0)
}

let spentCache = new Map<string, { monthStart: number; at: number; micro: number }>()

export function _resetDirectBudgetCacheForTesting(): void {
  spentCache = new Map()
}

function forgetSpent(fingerprint?: string): void {
  if (!fingerprint) {
    spentCache.clear()
    return
  }
  for (const key of [...spentCache.keys()]) {
    if (key === '*' || key.startsWith(`${fingerprint}:`)) spentCache.delete(key)
  }
}

async function spentSince(
  monthStart: number,
  now: number,
  cacheKey: string,
  fingerprint?: { value: string; includeUnattributed: boolean },
  fresh = false,
): Promise<number> {
  const cached = spentCache.get(cacheKey)
  if (!fresh && cached && cached.monthStart === monthStart && now - cached.at < SPENT_CACHE_MS)
    return cached.micro
  const window = gte(schema.gpt_direct_usage.created_at, monthStart)
  const where = fingerprint
    ? and(
        window,
        fingerprint.includeUnattributed
          ? or(
              eq(schema.gpt_direct_usage.key_fingerprint, fingerprint.value),
              isNull(schema.gpt_direct_usage.key_fingerprint),
            )
          : eq(schema.gpt_direct_usage.key_fingerprint, fingerprint.value),
      )
    : window
  const [row] = await db
    .select({ micro: sql<string | null>`sum(${schema.gpt_direct_usage.cost_micro_usd})` })
    .from(schema.gpt_direct_usage)
    .where(where)
  let micro = Number(row?.micro ?? 0)
  if (fingerprint) {
    const [held] = await db
      .select({ micro: sql<string | null>`sum(${schema.gpt_direct_budget_holds.micro_usd})` })
      .from(schema.gpt_direct_budget_holds)
      .where(
        and(
          eq(schema.gpt_direct_budget_holds.fingerprint, fingerprint.value),
          eq(schema.gpt_direct_budget_holds.month_start, monthStart),
        ),
      )
    micro += Number(held?.micro ?? 0)
  }
  spentCache.set(cacheKey, { monthStart, at: now, micro })
  return micro
}

export async function directSpentThisMonth(now = Date.now()): Promise<number> {
  return spentSince(budgetMonthStart(now), now, '*')
}

/**
 * 一把 key 本月已花。`includeUnattributed` 把多密钥上线前没记指纹的行算进来，
 * 只给配置里的第一把，避免旧账被丢掉或算进两把。
 */
export async function directKeySpent(
  fingerprint: string,
  includeUnattributed: boolean,
  now = Date.now(),
  fresh = false,
): Promise<number> {
  return spentSince(
    budgetMonthStart(now),
    now,
    `${fingerprint}:${includeUnattributed ? 1 : 0}`,
    { value: fingerprint, includeUnattributed },
    fresh,
  )
}

/** 预占和落账共用这把锁，避免一笔记账插在两次读数中间。 */
export function directBudgetLockKey(fingerprint: string): string {
  return `gpt-direct-budget:${fingerprint}`
}

async function lockDirectBudget(
  tx: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> },
  fingerprint: string,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${directBudgetLockKey(fingerprint)}))`)
}

/**
 * 在共享库里预占这次估算。别的 worker 要等这把锁，读到的余额含未完成的预占。
 * 用量和预留在同一条语句里读出，避免 READ COMMITTED 下两次查询中间漏掉一笔。
 * 装不下就返回 null，调用方换下一把。
 */
export async function reserveDirectBudget(input: {
  fingerprint: string
  includeUnattributed: boolean
  estimateMicroUsd: number
  capMicroUsd: number
  now?: number
}): Promise<string | null> {
  const now = input.now ?? Date.now()
  const monthStart = budgetMonthStart(now)
  const id = randomUUID()
  const reserved = await db.transaction(async (tx) => {
    await lockDirectBudget(tx, input.fingerprint)
    const month = new Date(monthStart).toISOString()
    const [spentRow] = await tx.execute<{ used: string | number | null }>(sql`
      select (
        coalesce((
          select sum(${schema.gpt_direct_usage.cost_micro_usd})
          from ${schema.gpt_direct_usage}
          where ${schema.gpt_direct_usage.created_at} >= ${month}::timestamptz
            and (
              ${schema.gpt_direct_usage.key_fingerprint} = ${input.fingerprint}
              or (${input.includeUnattributed} and ${schema.gpt_direct_usage.key_fingerprint} is null)
            )
        ), 0)
        + coalesce((
          select sum(${schema.gpt_direct_budget_holds.micro_usd})
          from ${schema.gpt_direct_budget_holds}
          where ${schema.gpt_direct_budget_holds.fingerprint} = ${input.fingerprint}
            and ${schema.gpt_direct_budget_holds.month_start} = ${month}::timestamptz
        ), 0)
      )::text as used
    `)
    const used = Number(spentRow?.used ?? 0)
    if (used + input.estimateMicroUsd > input.capMicroUsd) return null
    await tx.insert(schema.gpt_direct_budget_holds).values({
      id,
      fingerprint: input.fingerprint,
      month_start: monthStart,
      micro_usd: input.estimateMicroUsd,
      created_at: now,
    })
    return id
  })
  forgetSpent(input.fingerprint)
  return reserved
}

export async function releaseDirectReservation(id: string): Promise<void> {
  const [row] = await db
    .delete(schema.gpt_direct_budget_holds)
    .where(eq(schema.gpt_direct_budget_holds.id, id))
    .returning({ fingerprint: schema.gpt_direct_budget_holds.fingerprint })
  if (row) forgetSpent(row.fingerprint)
}

let beforeDirectUsageRecord: (() => Promise<void>) | undefined

/** 测试在落账事务开始前插入观察。此时已发出请求的预留必须还在。 */
export function _setBeforeDirectUsageRecordForTesting(hook?: () => Promise<void>): void {
  beforeDirectUsageRecord = hook
}

/** 记一条直连请求的成本。写失败只记日志：成本记账不能让已出的图交付失败。 */
export async function recordDirectUsage(input: {
  taskId?: string
  model: string
  size?: string
  quality?: string
  images: number
  keyFingerprint?: string
  payload?: unknown
  /** 预占还在时，和记账放进同一个事务，避免预占和实扣叠在一起。 */
  reservationId?: string
}): Promise<void> {
  const usage = input.payload === undefined ? null : readDirectUsage(input.payload)
  const cost = usage
    ? directCostMicroUsd(usage)
    : estimateDirectCostMicroUsd(input.size, input.quality, input.images)
  const now = Date.now()
  try {
    if (beforeDirectUsageRecord) await beforeDirectUsageRecord()
    await db.transaction(async (tx) => {
      if (input.keyFingerprint) await lockDirectBudget(tx, input.keyFingerprint)
      if (input.images > 0 && cost > 0) {
        await tx.insert(schema.gpt_direct_usage).values({
          id: randomUUID(),
          task_id: input.taskId ?? null,
          model: input.model,
          size: input.size ?? null,
          quality: input.quality ?? null,
          images: input.images,
          input_tokens: usage ? usage.inputTextTokens + usage.inputImageTokens : null,
          output_tokens: usage ? usage.outputTokens : null,
          cost_micro_usd: cost,
          estimated: !usage,
          key_fingerprint: input.keyFingerprint ?? null,
          created_at: now,
        })
      }
      if (input.reservationId) {
        await tx
          .delete(schema.gpt_direct_budget_holds)
          .where(eq(schema.gpt_direct_budget_holds.id, input.reservationId))
      }
    })
    if (input.reservationId) {
      forgetSpent(input.keyFingerprint)
      return
    }
    const monthStart = budgetMonthStart(now)
    for (const [key, entry] of spentCache) {
      if (entry.monthStart !== monthStart) continue
      const counts =
        key === '*' ||
        (input.keyFingerprint !== undefined && key.startsWith(`${input.keyFingerprint}:`)) ||
        (input.keyFingerprint === undefined && key.endsWith(':1'))
      if (counts) entry.micro += cost
    }
  } catch (err) {
    if (input.reservationId)
      await releaseDirectReservation(input.reservationId).catch(() => undefined)
    log.warn(
      { event: 'gpt.direct_usage_record_failed', err, model: input.model, cost },
      'direct usage record failed',
    )
  }
}
