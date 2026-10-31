import { isGptBasicRequest, isGptDirectModel } from '@image-playground/shared'
import { config } from '../../config'
import { log } from '../logger'
import { directBudgetAllows, estimateDirectCostMicroUsd } from './gpt-budget'
import { gptSchedulerBuckets, tryAcquireSchedulerSlots } from './scheduler'

/**
 * GPT Image 的两条通道：OpenAI 直连与 sub2api。
 *
 * - 会员默认直连；直连满了（每分钟张数、在途数、429 冷却）、超了月预算或不可用，立刻走 sub2api，不排队。
 * - 非会员默认 sub2api；sub2api 只是忙照常排队，熔断了才借直连（同样受直连额度与预算约束）。
 * - 一条路发出请求后超时或明确不可用，换另一条路重试一次（见 upstream.ts 的 callUpstream）。
 */
export type GptRoute = 'direct' | 'sub2api'

export function gptDirectConfigured(model: string): boolean {
  return config.gptDirect.enabled && config.gptDirect.apiKey !== '' && isGptDirectModel(model)
}

// ---- sub2api 熔断：本进程内计数，每个环境各管各的 ----

let consecutiveFailures = 0
let openUntil = 0
let now = (): number => Date.now()

export function _resetSub2apiBreakerForTesting(clock?: () => number): void {
  consecutiveFailures = 0
  openUntil = 0
  now = clock ?? (() => Date.now())
}

/** 熔断中：连续失败到阈值后的冷却期内。冷却过后放行，下一次结果决定是否再熔断。 */
export function sub2apiBreakerOpen(): boolean {
  return openUntil > now()
}

/** 只记服务端问题（5xx、429、超时、连接中断）；用户参数错之类的 4xx 不算。 */
export function recordSub2apiOutcome(ok: boolean): void {
  if (ok) {
    consecutiveFailures = 0
    return
  }
  consecutiveFailures += 1
  if (consecutiveFailures >= config.gptDirect.sub2apiBreakerFailures) {
    openUntil = now() + config.gptDirect.sub2apiBreakerCooldownMs
    consecutiveFailures = 0
    log.warn(
      { event: 'gpt.sub2api_breaker_open', untilMs: config.gptDirect.sub2apiBreakerCooldownMs },
      'sub2api breaker open; borrowing OpenAI direct',
    )
  }
}

/**
 * 直连此刻能不能接这一单：月预算够、额度桶拿得到。只是探一下——拿到的名额立即退回，
 * 真正发请求时再按条占（窗口很短，探到与真发之间被别人抢走就排一小会儿）。
 */
export async function directAvailableNow(
  model: string,
  request: { size?: string; quality?: string; n?: number },
): Promise<boolean> {
  if (!gptDirectConfigured(model)) return false
  const images = Math.max(1, request.n ?? 1)
  if (
    !(await directBudgetAllows(estimateDirectCostMicroUsd(request.size, request.quality, images)))
  )
    return false
  const lease = await tryAcquireSchedulerSlots(gptSchedulerBuckets(model, 'direct'), images)
  if (!lease) return false
  await lease.release({ refund: true })
  return true
}

/** 这一单先走哪条路。高档参数只有会员提交得上来（提交时已收过），按会员处理。 */
export async function firstGptRoute(input: {
  model: string
  member: boolean
  request: { size?: string; quality?: string; n?: number }
}): Promise<GptRoute> {
  const member = input.member || !isGptBasicRequest(input.request)
  if (!member && !sub2apiBreakerOpen()) return 'sub2api'
  return (await directAvailableNow(input.model, input.request)) ? 'direct' : 'sub2api'
}
