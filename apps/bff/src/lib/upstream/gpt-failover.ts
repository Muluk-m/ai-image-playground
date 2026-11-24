import {
  degradeGptImage26ForSub2api,
  gptImage26RequiresDirect,
  isGptSub2apiDeliverable,
  QUEUE_TIMEOUTS,
} from '@image-playground/shared'
import { config } from '../../config'
import { log } from '../logger'
import {
  GptImage26RouteUnavailableError,
  ImagePlanRequiredError,
  UpstreamQueueTimeoutError,
  UpstreamResultUnknownError,
  UpstreamTimeoutError,
} from './errors'
import { executeViaRoute } from './executors/registry'
import {
  callDirectTryingKeys,
  directAttemptProduced,
  directKeyDispatched,
  isRouteFailure,
  settleDirectAttempt,
  upstreamStatusOf,
} from './gpt-direct-executor'
import { DirectKeysExhaustedError } from './gpt-keys'
import {
  directAvailableNow,
  firstGptRoute,
  type GptRoute,
  gptImage26Configured,
  gptImage26Sub2apiModel,
  recordSub2apiOutcome,
  sub2apiBreakerOpen,
} from './gpt-routing'
import { directRoute, requiresGptDirect, resolveUpstream, type UpstreamRoute } from './routes'
import type { UpstreamCallResult } from './shared'
import type { AttemptOptions, UpstreamCallParams } from './types'

/** 换路前至少要剩这么多时间，否则换过去也来不及出图。 */
const GPT_FAILOVER_MIN_REMAINING_MS = 60_000
/** 会员选了直连、却在直连额度上排了这么久还没发出，就改走 sub2api。 */
const GPT_DIRECT_QUEUE_WAIT_MS = 5_000

function gptImage26Sub2apiCall(params: UpstreamCallParams): UpstreamCallParams {
  const model = gptImage26Sub2apiModel(params.model)
  return { ...params, model, imageProtocol: 'generations' }
}

function image26StrictBlocked(request: UpstreamCallParams['request']): boolean {
  return gptImage26RequiresDirect(request) || !isGptSub2apiDeliverable(request)
}

/**
 * 直连接不了时收成 sub2api 能出的 1K medium PNG。
 * 只改这一次调用的请求，不改落库正文：结算靠原请求重算降级倍率。
 * 严格入口保持原请求。
 */
async function withImage26Sub2apiRequest(params: UpstreamCallParams): Promise<UpstreamCallParams> {
  if (params.strictImageRequest) return params
  const degraded = degradeGptImage26ForSub2api(params.request)
  if (!degraded) return params
  await params.onImage26Degrade?.({ kind: degraded.kind, fields: degraded.fields })
  return { ...params, request: degraded.request }
}

async function callImage26Sub2api(
  params: UpstreamCallParams,
  sub2api: UpstreamRoute,
): Promise<UpstreamCallResult> {
  if (sub2apiBreakerOpen()) throw new GptImage26RouteUnavailableError()
  if (params.strictImageRequest && image26StrictBlocked(params.request))
    throw new GptImage26RouteUnavailableError(
      gptImage26RequiresDirect(params.request)
        ? '动图和矢量图需要 OpenAI 直连，当前直连不可用'
        : '当前高分辨率/高画质需要 OpenAI 直连，暂不可用',
    )
  const next = await withImage26Sub2apiRequest(params)
  await params.onGptRoute?.('sub2api')
  try {
    const result = await executeViaRoute(gptImage26Sub2apiCall(next), sub2api)
    recordSub2apiOutcome(true)
    return result
  } catch (error) {
    if (isRouteFailure(error) || error instanceof UpstreamTimeoutError) recordSub2apiOutcome(false)
    throw error
  }
}

/**
 * 2.6：直连开关开着且有 key 就走 OpenAI。开关关掉、没有 key、预算用尽或 key 停用时
 * 降级后走 sub2api，不记直连花费。熔断或上游失败仍把错误抛出去，由任务失败退款。
 * 已经提交过的异步任务只在原路续轮询。
 */
export async function callGptImage26(params: UpstreamCallParams): Promise<UpstreamCallResult> {
  const sub2api = resolveUpstream(params.provider, params.model)
  if (params.resume?.taskIds.length) {
    // 不改写 gpt_route：续轮询沿用落库的那条路。没记下通道时按直连，避免拿 OpenAI 的 id 去问网关。
    // 执行期降级只落下 image26_degrade 的 kind/fields，正文仍是原档。这里再收口，
    // 补提交才不会把 2K / 高画质 / GIF / SVG 原样送给 sub2api。
    if (params.persistedGptRoute === 'sub2api') {
      const next = await withImage26Sub2apiRequest(params)
      return executeViaRoute(gptImage26Sub2apiCall(next), sub2api)
    }
    const format = params.request.output_format
    return executeViaRoute(params, {
      ...directRoute(params.model),
      supportsNativeN: format !== 'gif' && format !== 'svg',
    })
  }
  if (!gptImage26Configured()) return callImage26Sub2api(params, sub2api)
  // 直连走和 2.5 同一套预占、落账、停用和冷却。一把 key 都接不了就降级，不报模型不可用。
  // 通道先落库再发请求，避免和 key 指纹、结算抢同一行。
  let fingerprint: string | undefined
  try {
    const invoked = await callDirectTryingKeys(params, params.model, {}, async (next) => {
      fingerprint = next
      await params.onGptRoute?.('direct')
    })
    await settleDirectAttempt({
      params,
      ok: true,
      payload: invoked.result.payload,
      fingerprint: invoked.fingerprint,
      reservationId: invoked.reservationId,
      dispatched: true,
      produced: true,
    })
    return invoked.result
  } catch (error) {
    await settleDirectAttempt({
      params,
      ok: false,
      error,
      fingerprint,
      dispatched: directKeyDispatched(error),
      produced: directAttemptProduced(error),
    })
    if (!(error instanceof DirectKeysExhaustedError)) throw error
    return callImage26Sub2api(params, sub2api)
  }
}

function gptRouteFor(kind: GptRoute, model: string, sub2api: UpstreamRoute): UpstreamRoute {
  return kind === 'direct' ? directRoute(model) : sub2api
}

/**
 * GPT Image 两条通道（见 upstream/gpt-routing.ts）：按会员身份选第一条；第一条发出后超过单路时限没结果，
 * 或明确不可用（429、5xx、连接中断），换另一条重试一次，两路共用同一个硬截止。同一条直连里换密钥
 * 不算这一次。sub2api 异步任务一旦受理就不换路：结果交给轮询与对账，换过去可能重复出图。
 * 用户取消、部分出图、参数错不换路。
 */
export async function callGptDualRoute(
  params: UpstreamCallParams,
  sub2api: UpstreamRoute,
): Promise<UpstreamCallResult> {
  const { model, request } = params
  const member = params.gptMember === true
  const deadlineAt = Date.now() + QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS
  const strict = requiresGptDirect(params)
  const first = await firstGptRoute({ model, member, request, strictImageRequest: strict })
  const other: GptRoute = first === 'direct' ? 'sub2api' : 'direct'

  /** 换到 other 这条路此刻是否可行：时间够、对方没熔断、直连有额度与预算。 */
  const canSwitch = async (): Promise<boolean> => {
    if (strict) return false
    if (params.signal?.aborted) return false
    if (deadlineAt - Date.now() < GPT_FAILOVER_MIN_REMAINING_MS) return false
    if (other === 'sub2api') return !sub2apiBreakerOpen()
    return directAvailableNow(model, request)
  }

  const run = async (kind: GptRoute, timeoutMs?: number) => {
    const state = {
      dispatched: false,
      asyncAccepted: false,
      /** fan-out 里已经有一张完整返回：再掐断换路会丢掉已出、已计费的图。 */
      responded: false,
      timedOut: false,
      reason: 'attempt_timeout' as 'attempt_timeout' | 'direct_queue_full',
    }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let queueTimer: ReturnType<typeof setTimeout> | undefined
    /** 到点且换得过去才叫停这一路；换不过去就让它继续跑到硬截止，别白白掐掉一条可能快出图的请求。 */
    const switchWhenPossible = (reason: typeof state.reason) => {
      void canSwitch().then((ok) => {
        if (!ok || state.asyncAccepted || state.responded || controller.signal.aborted) return
        state.timedOut = true
        state.reason = reason
        controller.abort()
      })
    }
    const onDispatched = () => {
      state.dispatched = true
      if (queueTimer) clearTimeout(queueTimer)
      if (timeoutMs === undefined || timer) return
      timer = setTimeout(() => switchWhenPossible('attempt_timeout'), timeoutMs)
      timer.unref?.()
    }
    // 直连额度是选路时探的，真发时可能刚被别的 worker 抢走：在直连桶上排久了也换路，不排到硬截止。
    if (kind === 'direct' && timeoutMs !== undefined) {
      queueTimer = setTimeout(() => {
        if (!state.dispatched) switchWhenPossible('direct_queue_full')
      }, GPT_DIRECT_QUEUE_WAIT_MS)
      queueTimer.unref?.()
    }
    const attemptParams: UpstreamCallParams = {
      ...params,
      onUpstreamTaskIds: async (taskIds) => {
        state.asyncAccepted = true
        await params.onUpstreamTaskIds?.(taskIds)
      },
    }
    const attemptOptions: AttemptOptions = {
      signal: controller.signal,
      deadlineAt,
      onDispatched,
      onResponse: () => {
        state.responded = true
      },
    }
    let fingerprint: string | undefined
    try {
      await params.onGptRoute?.(kind)
      if (kind === 'direct') {
        const invoked = await callDirectTryingKeys(attemptParams, model, attemptOptions, (next) => {
          fingerprint = next
        })
        return {
          ok: true as const,
          result: invoked.result,
          state,
          fingerprint: invoked.fingerprint,
          reservationId: invoked.reservationId,
        }
      }
      const result = await executeViaRoute(
        attemptParams,
        gptRouteFor(kind, model, sub2api),
        attemptOptions,
      )
      return { ok: true as const, result, state, fingerprint }
    } catch (error) {
      return { ok: false as const, error, state, fingerprint }
    } finally {
      if (timer) clearTimeout(timer)
      if (queueTimer) clearTimeout(queueTimer)
    }
  }

  const settle = async (
    kind: GptRoute,
    outcome: Awaited<ReturnType<typeof run>>,
  ): Promise<void> => {
    if (kind === 'sub2api') {
      if (outcome.ok) recordSub2apiOutcome(true)
      else if (outcome.state.timedOut || isRouteFailure(outcome.error)) recordSub2apiOutcome(false)
      return
    }
    await settleDirectAttempt({
      params,
      ok: outcome.ok,
      payload: outcome.ok ? outcome.result.payload : undefined,
      error: outcome.ok ? undefined : outcome.error,
      fingerprint: outcome.fingerprint,
      reservationId: outcome.ok ? outcome.reservationId : undefined,
      dispatched: outcome.ok || directKeyDispatched(outcome.error),
      produced: outcome.state.responded,
    })
  }

  // 直连原生 n 一条请求出 n 张，张数越多越慢：每多一张多给 30 秒。sub2api 逐张并发，不放大。
  const timeoutMs =
    first === 'direct'
      ? config.gptDirect.attemptTimeoutMs + (Math.max(1, request.n ?? 1) - 1) * 30_000
      : config.gptDirect.sub2apiAttemptTimeoutMs
  const firstOutcome = await run(first, timeoutMs)
  await settle(first, firstOutcome)
  if (firstOutcome.ok) return firstOutcome.result

  const { error, state } = firstOutcome
  const exhausted = error instanceof DirectKeysExhaustedError
  const surfaced = exhausted ? error.causeError : error
  if (strict) {
    // 直连密钥都不可用，和高档请求借不到直连一样：不改走 sub2api。
    if (exhausted) throw new ImagePlanRequiredError({ cause: surfaced })
    // Never replace an uncertain/partial result with a definitive rejection: reconciliation owns it.
    if (
      error instanceof UpstreamQueueTimeoutError ||
      (!(error instanceof UpstreamResultUnknownError) && isRouteFailure(error))
    )
      throw new ImagePlanRequiredError({ cause: error })
    throw error
  }
  // 非会员只在 sub2api 超时时借直连；sub2api 报错计入熔断，熔断后的新任务才整单走直连。
  // 直连密钥换完仍不可用，才占用这一次 direct/sub2api 换路。
  const eligible =
    !params.signal?.aborted &&
    !state.asyncAccepted &&
    (state.timedOut || exhausted || (isRouteFailure(error) && (first === 'direct' || member)))
  if (!eligible || (!state.timedOut && !(await canSwitch()))) throw surfaced

  log.warn(
    {
      event: 'gpt.route_failover',
      model,
      from: first,
      to: other,
      reason: state.timedOut ? state.reason : exhausted ? 'direct_keys_exhausted' : 'route_failure',
      upstreamStatus: upstreamStatusOf(surfaced),
    },
    'gpt route failover',
  )
  const secondOutcome = await run(other)
  await settle(other, secondOutcome)
  if (secondOutcome.ok) return secondOutcome.result
  // 第一条路已发出、结果未知（被单路时限掐断或连接中断）时，两路都没成也不能当确定失败：
  // 否则任务级重试会再派发一整单。保留结果未知，交给对账或按未知失败处理。
  // 直连的 per-key 标记不能拿来判断 sub2api。sub2api 仍看这一路自己的 dispatched。
  const firstSent = first === 'direct' ? directKeyDispatched(error) : state.dispatched
  const secondSent =
    other === 'direct' ? directKeyDispatched(secondOutcome.error) : secondOutcome.state.dispatched
  const firstUnknown = firstSent && (state.timedOut || error instanceof UpstreamResultUnknownError)
  const secondUnknown =
    secondSent &&
    (secondOutcome.state.timedOut || secondOutcome.error instanceof UpstreamResultUnknownError)
  if (firstUnknown || secondUnknown) {
    if (secondOutcome.error instanceof UpstreamResultUnknownError) throw secondOutcome.error
    const detail =
      secondOutcome.error instanceof Error ? secondOutcome.error.message.slice(0, 200) : '失败'
    // 不挂 cause：错误会继承 cause 的上游状态码，429/5xx 会被 task-runner 当成可重试。
    throw new UpstreamResultUnknownError(
      `换路后仍失败（${detail}）；已发出的一路结果未知，未重复生成`,
      { requiresReconciliation: params.reconciliationRequired === true },
    )
  }
  throw secondOutcome.error
}
