import { randomUUID } from 'node:crypto'
import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { and, eq, gt, gte, isNull, lt, or, sql } from 'drizzle-orm'
import { config } from '../../config'
import { db, schema } from '../../db/client'
import { log } from '../logger'
import { budgetMonthStart } from './gpt-budget'

/**
 * Gemini 直连（Vertex / Nano Banana）的月度预算与用量统计记账。
 * - 月预算按台北时间自然月计算（复用 `budgetMonthStart`）。
 * - 费用估算优先结合响应 `usageMetadata` 与模型/分辨率档位单价；无法取得 token 时按档位估算并标 `estimated: true`。
 * - 每次调用（成功 / 429 限流 / 其他错误）均写入 `gemini_direct_usage`，供后台按 Key、按日、按模型统计。
 */

const SPENT_CACHE_MS = 30_000
export const GEMINI_HOLD_TTL_MS = QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS + 15 * 60_000

/**
 * Vertex / Gemini 图像模型每张图估算单价（micro-USD，1_000_000 = $1.00）。
 * 参考 Google Vertex AI Image 公开定价：
 * - Pro (gemini-3-pro-image): 1K/2K ~$0.134, 4K ~$0.240
 * - Flash / Nano Banana 2.1: 1K ~$0.039, 2K ~$0.067, 4K ~$0.101
 * - Flash Lite: 1K ~$0.020, 2K ~$0.039, 4K ~$0.067
 */
const IMAGE_PRICE_MICRO_USD: Readonly<
  Record<string, Readonly<Record<'1K' | '2K' | '4K', number>>>
> = {
  'gemini-3-pro-image': { '1K': 134_000, '2K': 134_000, '4K': 240_000 },
  'gemini-nano-banana-2.1': { '1K': 39_000, '2K': 67_000, '4K': 101_000 },
  'gemini-3.1-flash-lite-image': { '1K': 20_000, '2K': 39_000, '4K': 67_000 },
}

const DEFAULT_IMAGE_PRICE_MICRO_USD: Readonly<Record<'1K' | '2K' | '4K', number>> = {
  '1K': 39_000,
  '2K': 67_000,
  '4K': 101_000,
}

/** 百万输入 token 单价（micro-USD / token = USD / 1M tokens）：用于叠加 prompt + 参考图输入估算。 */
const INPUT_PRICE_PER_MILLION_USD: Readonly<Record<string, number>> = {
  'gemini-3-pro-image': 2,
  'gemini-nano-banana-2.1': 0.5,
  'gemini-3.1-flash-lite-image': 0.25,
}

export interface GeminiUsageMetadata {
  readonly promptTokens: number
  readonly outputTokens: number
}

function normalizeImageSizeTier(size: string | undefined): '1K' | '2K' | '4K' {
  const upper = size?.trim().toUpperCase()
  if (upper === '4K') return '4K'
  if (upper === '2K') return '2K'
  return '1K'
}

/** 从 Gemini / Vertex generateContent 响应里提取 usageMetadata。 */
export function readGeminiUsage(payload: unknown): GeminiUsageMetadata | null {
  if (!payload || typeof payload !== 'object') return null
  const meta = (payload as { usageMetadata?: unknown }).usageMetadata
  if (!meta || typeof meta !== 'object') return null
  const m = meta as {
    promptTokenCount?: unknown
    candidatesTokenCount?: unknown
    thoughtsTokenCount?: unknown
    totalTokenCount?: unknown
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
  const promptTokens = num(m.promptTokenCount)
  const candidates = num(m.candidatesTokenCount)
  const thoughts = num(m.thoughtsTokenCount)
  const total = num(m.totalTokenCount)
  const outputTokens = candidates + thoughts || Math.max(0, total - promptTokens)
  if (promptTokens === 0 && outputTokens === 0) return null
  return { promptTokens: Math.round(promptTokens), outputTokens: Math.round(outputTokens) }
}

/** 估算一次 Gemini 直连生图请求的美元成本（micro-USD）。 */
export function estimateGeminiCostMicroUsd(
  model: string,
  imageSize: string | undefined,
  images: number,
  usage?: GeminiUsageMetadata | null,
): number {
  const count = Math.max(0, images)
  const tier = normalizeImageSizeTier(imageSize)
  const table = IMAGE_PRICE_MICRO_USD[model] ?? DEFAULT_IMAGE_PRICE_MICRO_USD
  const imageCost = count > 0 ? table[tier] * count : 0
  if (!usage) return imageCost
  const inputRate = INPUT_PRICE_PER_MILLION_USD[model] ?? 0.5
  const inputCost = Math.ceil(usage.promptTokens * inputRate)
  return imageCost + inputCost
}

/**
 * 派发前的保守预算预占（micro-USD）：在图片固定档位单价基础上叠加输入 token 保守余量，
 * 避免剩余额度刚好够一张图时，结算叠加 prompt token 造成超额；请求完成后立即按实际用量结算并释放差额。
 */
export function estimateGeminiReservationMicroUsd(
  model: string,
  imageSize: string | undefined,
  images: number,
  estimatedInputTokens = 4_000,
): number {
  const count = Math.max(0, images)
  if (count === 0) return 0
  const base = estimateGeminiCostMicroUsd(model, imageSize, count)
  const inputRate = INPUT_PRICE_PER_MILLION_USD[model] ?? 0.5
  const inputMargin = Math.ceil(Math.max(1_000, estimatedInputTokens) * inputRate)
  return base + inputMargin
}

export function geminiKeyBudgetCapMicroUsd(budgetUsd: number): number {
  return Math.floor((budgetUsd * 1_000_000 * config.geminiDirect.budgetPercent) / 100)
}

let spentCache = new Map<string, { monthStart: number; at: number; micro: number }>()

export function _resetGeminiBudgetCacheForTesting(): void {
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
  if (!fresh && cached && cached.monthStart === monthStart && now - cached.at < SPENT_CACHE_MS) {
    return cached.micro
  }
  const window = gte(schema.gemini_direct_usage.created_at, monthStart)
  const where = fingerprint
    ? and(
        window,
        fingerprint.includeUnattributed
          ? or(
              eq(schema.gemini_direct_usage.key_fingerprint, fingerprint.value),
              isNull(schema.gemini_direct_usage.key_fingerprint),
            )
          : eq(schema.gemini_direct_usage.key_fingerprint, fingerprint.value),
      )
    : window
  const [row] = await db
    .select({ micro: sql<string | null>`sum(${schema.gemini_direct_usage.cost_micro_usd})` })
    .from(schema.gemini_direct_usage)
    .where(where)
  let micro = Number(row?.micro ?? 0)
  if (fingerprint) {
    const [held] = await db
      .select({ micro: sql<string | null>`sum(${schema.gemini_direct_budget_holds.micro_usd})` })
      .from(schema.gemini_direct_budget_holds)
      .where(
        and(
          eq(schema.gemini_direct_budget_holds.fingerprint, fingerprint.value),
          eq(schema.gemini_direct_budget_holds.month_start, monthStart),
          gt(schema.gemini_direct_budget_holds.expires_at, now),
        ),
      )
    micro += Number(held?.micro ?? 0)
  }
  spentCache.set(cacheKey, { monthStart, at: now, micro })
  return micro
}

export async function geminiSpentThisMonth(now = Date.now()): Promise<number> {
  return spentSince(budgetMonthStart(now), now, '*')
}

export async function geminiKeySpent(
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

export function geminiBudgetLockKey(fingerprint: string): string {
  return `gemini-direct-budget:${fingerprint}`
}

async function lockGeminiBudget(
  tx: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> },
  fingerprint: string,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${geminiBudgetLockKey(fingerprint)}))`)
}

/** 在共享库里原子预占本次估算额度；超过这把 key 的月预算上限返回 null。 */
export async function reserveGeminiBudget(input: {
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
    await lockGeminiBudget(tx, input.fingerprint)
    await tx
      .delete(schema.gemini_direct_budget_holds)
      .where(
        and(
          eq(schema.gemini_direct_budget_holds.fingerprint, input.fingerprint),
          lt(schema.gemini_direct_budget_holds.expires_at, now),
        ),
      )
    const month = new Date(monthStart).toISOString()
    const [spentRow] = await tx.execute<{ used: string | number | null }>(sql`
      select (
        coalesce((
          select sum(${schema.gemini_direct_usage.cost_micro_usd})
          from ${schema.gemini_direct_usage}
          where ${schema.gemini_direct_usage.created_at} >= ${month}::timestamptz
            and (
              ${schema.gemini_direct_usage.key_fingerprint} = ${input.fingerprint}
              or (${input.includeUnattributed} and ${schema.gemini_direct_usage.key_fingerprint} is null)
            )
        ), 0)
        + coalesce((
          select sum(${schema.gemini_direct_budget_holds.micro_usd})
          from ${schema.gemini_direct_budget_holds}
          where ${schema.gemini_direct_budget_holds.fingerprint} = ${input.fingerprint}
            and ${schema.gemini_direct_budget_holds.month_start} = ${month}::timestamptz
            and ${schema.gemini_direct_budget_holds.expires_at} > ${new Date(now).toISOString()}::timestamptz
        ), 0)
      )::text as used
    `)
    const used = Number(spentRow?.used ?? 0)
    if (used + input.estimateMicroUsd > input.capMicroUsd) return null
    await tx.insert(schema.gemini_direct_budget_holds).values({
      id,
      fingerprint: input.fingerprint,
      month_start: monthStart,
      micro_usd: input.estimateMicroUsd,
      created_at: now,
      expires_at: now + GEMINI_HOLD_TTL_MS,
    })
    return id
  })
  forgetSpent(input.fingerprint)
  return reserved
}

export async function releaseGeminiReservation(id: string): Promise<void> {
  try {
    const [row] = await db
      .delete(schema.gemini_direct_budget_holds)
      .where(eq(schema.gemini_direct_budget_holds.id, id))
      .returning({ fingerprint: schema.gemini_direct_budget_holds.fingerprint })
    if (row) forgetSpent(row.fingerprint)
  } catch (err) {
    log.warn(
      { event: 'gemini.direct_reservation_release_failed', err, reservationId: id },
      'gemini direct reservation release failed',
    )
  }
}

/**
 * 记录一次 Gemini 直连请求的结果与估算花费，并在同一事务里释放对应的预算预占。
 * 写失败只记日志，不阻塞已出图的交付；返回是否成功落账并释放预占。
 */
export async function recordGeminiUsage(input: {
  taskId?: string
  model: string
  imageSize?: string
  images: number
  status: 'ok' | 'rate_limited' | 'error'
  /** 已派发但超时/断连结果未知时仍按估算记入花费，避免绕过月预算封顶。 */
  billUnknown?: boolean
  /** 结果未知时的保守结算下限（通常传入本次完整预占金额，保留输入 token 余量）。 */
  unknownCostMicroUsd?: number
  upstreamStatus?: number
  keyFingerprint?: string
  payload?: unknown
  reservationId?: string
}): Promise<boolean> {
  const usage = input.payload === undefined ? null : readGeminiUsage(input.payload)
  const billableImages =
    input.status === 'ok' ? input.images : input.billUnknown ? Math.max(1, input.images) : 0
  const baseCost =
    billableImages > 0 || usage !== null
      ? estimateGeminiCostMicroUsd(input.model, input.imageSize, billableImages, usage)
      : 0
  const cost =
    input.billUnknown && input.unknownCostMicroUsd !== undefined
      ? Math.max(baseCost, input.unknownCostMicroUsd)
      : baseCost
  const now = Date.now()
  const usageId = randomUUID()
  const maxAttempts = cost > 0 ? 3 : 1
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await db.transaction(async (tx) => {
        if (input.keyFingerprint) await lockGeminiBudget(tx, input.keyFingerprint)
        await tx
          .insert(schema.gemini_direct_usage)
          .values({
            id: usageId,
            task_id: input.taskId ?? null,
            model: input.model,
            image_size: input.imageSize ?? null,
            images: input.status === 'ok' ? Math.max(0, input.images) : 0,
            input_tokens: usage ? usage.promptTokens : null,
            output_tokens: usage ? usage.outputTokens : null,
            cost_micro_usd: cost,
            estimated: !usage,
            status: input.status,
            upstream_status: input.upstreamStatus ?? null,
            key_fingerprint: input.keyFingerprint ?? null,
            created_at: now,
          })
          .onConflictDoNothing({ target: schema.gemini_direct_usage.id })
        if (input.reservationId) {
          await tx
            .delete(schema.gemini_direct_budget_holds)
            .where(eq(schema.gemini_direct_budget_holds.id, input.reservationId))
        }
      })
      forgetSpent(input.keyFingerprint)
      return true
    } catch (err) {
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 150))
        continue
      }
      log.warn(
        {
          event: 'gemini.direct_usage_record_failed',
          err,
          model: input.model,
          status: input.status,
          cost,
          ...(cost > 0 && input.reservationId
            ? { reservationId: input.reservationId, holdRetained: true }
            : {}),
        },
        'gemini direct usage record failed',
      )
      return false
    }
  }
  return false
}
