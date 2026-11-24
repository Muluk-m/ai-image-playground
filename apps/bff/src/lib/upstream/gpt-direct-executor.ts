import { log } from '../logger'
import {
  UpstreamPartialResultError,
  UpstreamQueueTimeoutError,
  UpstreamResultUnknownError,
  UpstreamTimeoutError,
} from './errors'
import { executeViaRoute } from './executors/registry'
import { estimateDirectCostMicroUsd, recordDirectUsage } from './gpt-budget'
import {
  classifyDirectKeyFailure,
  DirectKeysExhaustedError,
  markDirectKeyCooldown,
  markDirectKeyDisabled,
  notifyDirectKeyDisabled,
  releaseDirectKeyReservation,
  reserveDirectKey,
  selectDirectKey,
} from './gpt-keys'
import { directAttemptImages, directAttemptPayload } from './partial'
import { directRoute } from './routes'
import { coolDownSchedulerBuckets, gptSchedulerBuckets } from './scheduler'
import type { UpstreamCallResult } from './shared'
import type { AttemptOptions, UpstreamCallParams } from './types'

export function upstreamStatusOf(error: unknown): number | undefined {
  const status = (error as { upstreamStatus?: unknown } | null)?.upstreamStatus
  return typeof status === 'number' ? status : undefined
}

export function directReservationId(error: unknown): string | undefined {
  const id = (error as { directReservationId?: unknown } | null)?.directReservationId
  return typeof id === 'string' ? id : undefined
}

/** 抛错的那一把 key 自己有没有把请求发出去。没标过的按没发出。 */
export function directKeyDispatched(error: unknown): boolean {
  return (error as { directKeyDispatched?: unknown } | null)?.directKeyDispatched === true
}

/** 抛错前这一路有没有已经出过图。没标过的按没出。 */
export function directAttemptProduced(error: unknown): boolean {
  return (error as { directAttemptProduced?: unknown } | null)?.directAttemptProduced === true
}

/** 服务端问题（换一条路可能就好）：429、5xx、连接或响应中断。参数错、审核拒绝之类换路也没用。 */
export function isRouteFailure(error: unknown): boolean {
  if (error instanceof UpstreamPartialResultError || error instanceof UpstreamQueueTimeoutError)
    return false
  const status = upstreamStatusOf(error)
  if (status !== undefined) return status === 429 || status >= 500
  return error instanceof UpstreamResultUnknownError && !(error instanceof UpstreamTimeoutError)
}

/**
 * 直连这一路的落账。出了图按 usage 记；发出后结果未知按档位估算。
 * 明确的 HTTP 错误且一张图都没出，不记入直连花费。sub2api 不走这里。
 */
export async function settleDirectAttempt(input: {
  params: UpstreamCallParams
  ok: boolean
  payload?: unknown
  error?: unknown
  fingerprint?: string
  reservationId?: string
  dispatched: boolean
  produced: boolean
}): Promise<void> {
  const request = input.params.request
  const reservationId = input.ok ? input.reservationId : directReservationId(input.error)
  const dispatched = input.ok || input.dispatched || directKeyDispatched(input.error)
  const produced = input.ok || input.produced || directAttemptProduced(input.error)
  if (!dispatched) {
    if (reservationId) await releaseDirectKeyReservation(reservationId)
    return
  }
  if (!input.ok && upstreamStatusOf(input.error) !== undefined && !produced) {
    if (reservationId) await releaseDirectKeyReservation(reservationId)
    return
  }
  const payload = directAttemptPayload(input.ok, input.payload, input.error)
  const images = directAttemptImages(
    request.n ?? 1,
    payload,
    !input.ok && input.error instanceof UpstreamPartialResultError,
  )
  await recordDirectUsage({
    ...(input.params.taskId ? { taskId: input.params.taskId } : {}),
    model: input.params.model,
    ...(request.size ? { size: request.size } : {}),
    ...(request.quality ? { quality: request.quality } : {}),
    images,
    ...(input.fingerprint ? { keyFingerprint: input.fingerprint } : {}),
    ...(payload !== undefined ? { payload } : {}),
    ...(reservationId ? { reservationId } : {}),
  })
}

/**
 * 直连这一路按顺序试密钥。额度耗尽、账单停了、401 或 429 立刻换下一把，不算 direct/sub2api 换路。
 * 已经出过一张图就不再换 key，免得把出过的图再生成一遍。
 */
export async function callDirectTryingKeys(
  params: UpstreamCallParams,
  model: string,
  attempt: AttemptOptions,
  onAttempt: (fingerprint: string) => void | Promise<void>,
): Promise<{ result: UpstreamCallResult; fingerprint: string; reservationId?: string }> {
  const images = Math.max(1, params.request.n ?? 1)
  const estimate = estimateDirectCostMicroUsd(params.request.size, params.request.quality, images)
  const exclude = new Set<string>()
  let lastError: unknown
  while (!attempt.signal?.aborted && !params.signal?.aborted) {
    const reserved = await reserveDirectKey({ estimateMicroUsd: estimate, exclude })
    if (!reserved)
      throw new DirectKeysExhaustedError(lastError ?? new Error('no openai direct key'))
    const { key, reservationId } = reserved
    exclude.add(key.fingerprint)
    let produced = false
    let thisKeyDispatched = false
    try {
      // 通道和指纹回调在请求发出前落完。派发回调里再写，会和 key 记录抢同一行。
      await onAttempt(key.fingerprint)
      // 探下一把放在 try 里：它抛错时，上面刚建的预占也要走下面的释放。
      const another = await selectDirectKey({ estimateMicroUsd: estimate, exclude })
      const result = await executeViaRoute(
        params,
        directRoute(model, key, { skipSharedRateLimitCooldown: another !== null }),
        {
          ...attempt,
          onDispatched: () => {
            thisKeyDispatched = true
            return attempt.onDispatched?.()
          },
          onResponse: () => {
            produced = true
            attempt.onResponse?.()
          },
        },
      )
      return { result, fingerprint: key.fingerprint, reservationId }
    } catch (caught) {
      // 取消原因可以是任意值（null、字符串）；标记要挂在对象上，所以非对象先包一层。
      const error: unknown =
        typeof caught === 'object' && caught !== null
          ? caught
          : new Error(String(caught), { cause: caught })
      Object.assign(error as object, {
        directKeyDispatched: thisKeyDispatched,
        directAttemptProduced: produced,
      })
      if (thisKeyDispatched && (produced || upstreamStatusOf(error) === undefined)) {
        // 已经发出但结果未知，或已经出过图。预留留到 settle 的落账事务里一次转成用量。
        // 先删掉的话，落账前这段两边都没算这笔钱，月度上限会被超。
        // 已经出过图再换 key 还会把图重新生成一遍。
        Object.assign(error as object, { directReservationId: reservationId })
        throw error
      }
      await releaseDirectKeyReservation(reservationId)
      const action = classifyDirectKeyFailure(error)
      if (action === 'quota' || action === 'invalid') {
        await markDirectKeyDisabled(key, action, error)
        notifyDirectKeyDisabled(key, action)
        lastError = error
        log.warn(
          {
            event: 'gpt.direct_key_switch',
            fingerprint: key.label,
            action,
            upstreamStatus: upstreamStatusOf(error),
          },
          'openai direct key disabled; trying the next key',
        )
        continue
      }
      if (action === 'cooldown') {
        await markDirectKeyCooldown(key, error)
        const still = await selectDirectKey({ estimateMicroUsd: estimate, exclude })
        if (!still) {
          await coolDownSchedulerBuckets(
            gptSchedulerBuckets(model, 'direct')
              .filter((bucket) => bucket.coolDownOnRateLimit)
              .map((bucket) => bucket.key),
          )
        }
        lastError = error
        log.warn(
          {
            event: 'gpt.direct_key_switch',
            fingerprint: key.label,
            action: 'cooldown',
            upstreamStatus: upstreamStatusOf(error),
          },
          'openai direct key cooling down; trying the next key',
        )
        continue
      }
      throw error
    }
  }
  throw (
    lastError ?? params.signal?.reason ?? new DOMException('Upstream request aborted', 'AbortError')
  )
}
