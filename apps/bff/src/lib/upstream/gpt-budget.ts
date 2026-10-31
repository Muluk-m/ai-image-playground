import { imageSizeTier } from '@image-playground/shared'
import { gte, sql } from 'drizzle-orm'
import { config } from '../../config'
import { db, schema } from '../../db/client'
import { log } from '../logger'

/**
 * OpenAI 直连的月预算：每条请求按上游回报的 token 折算成本落库，本月累计加上这次的预估超过
 * 「月预算 × 封顶比例」就不再选直连（会员改走 sub2api）。月按台北时间的自然月算。
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

export function directBudgetCapMicroUsd(): number {
  const gpt = config.gptDirect
  return Math.floor((gpt.monthlyBudgetUsd * 1_000_000 * gpt.budgetPercent) / 100)
}

let spentCache: { monthStart: number; at: number; micro: number } | undefined

export function _resetDirectBudgetCacheForTesting(): void {
  spentCache = undefined
}

export async function directSpentThisMonth(now = Date.now()): Promise<number> {
  const monthStart = budgetMonthStart(now)
  if (spentCache && spentCache.monthStart === monthStart && now - spentCache.at < SPENT_CACHE_MS)
    return spentCache.micro
  const [row] = await db
    .select({ micro: sql<string | null>`sum(${schema.gpt_direct_usage.cost_micro_usd})` })
    .from(schema.gpt_direct_usage)
    .where(gte(schema.gpt_direct_usage.created_at, monthStart))
  const micro = Number(row?.micro ?? 0)
  spentCache = { monthStart, at: now, micro }
  return micro
}

/** 这次请求（预估成本）发出去后本月仍不超封顶。查询失败按超了处理：宁可走 sub2api，不冒超支的险。 */
export async function directBudgetAllows(estimateMicroUsd: number): Promise<boolean> {
  try {
    return (await directSpentThisMonth()) + estimateMicroUsd <= directBudgetCapMicroUsd()
  } catch (err) {
    log.warn({ event: 'gpt.direct_budget_read_failed', err }, 'direct budget read failed')
    return false
  }
}

/** 记一条直连请求的成本。写失败只记日志：成本记账不能让已出的图交付失败。 */
export async function recordDirectUsage(input: {
  taskId?: string
  model: string
  size?: string
  quality?: string
  images: number
  payload?: unknown
}): Promise<void> {
  const usage = input.payload === undefined ? null : readDirectUsage(input.payload)
  const cost = usage
    ? directCostMicroUsd(usage)
    : estimateDirectCostMicroUsd(input.size, input.quality, input.images)
  const now = Date.now()
  try {
    await db.insert(schema.gpt_direct_usage).values({
      id: crypto.randomUUID(),
      task_id: input.taskId ?? null,
      model: input.model,
      size: input.size ?? null,
      quality: input.quality ?? null,
      images: input.images,
      input_tokens: usage ? usage.inputTextTokens + usage.inputImageTokens : null,
      output_tokens: usage ? usage.outputTokens : null,
      cost_micro_usd: cost,
      estimated: !usage,
      created_at: now,
    })
    if (spentCache && spentCache.monthStart === budgetMonthStart(now)) spentCache.micro += cost
  } catch (err) {
    log.warn(
      { event: 'gpt.direct_usage_record_failed', err, model: input.model, cost },
      'direct usage record failed',
    )
  }
}
