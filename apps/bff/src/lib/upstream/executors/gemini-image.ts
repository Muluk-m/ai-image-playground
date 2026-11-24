import type { HydratedSubmitRequest } from '../../imageArchive'
import { log } from '../../logger'
import { planDispatchedImage, stampReceipt } from '../adapters'
import { UpstreamResultUnknownError, UpstreamTimeoutError } from '../errors'
import { fanOutRequests } from '../fanout'
import { mergeGeminiCandidateResults } from '../gemini'
import {
  estimateGeminiCostMicroUsd,
  recordGeminiUsage,
  releaseGeminiReservation,
} from '../gemini-budget'
import { hasGeminiDirectPool } from '../gemini-key-config'
import {
  classifyGeminiKeyFailure,
  GeminiDirectKeysExhaustedError,
  markGeminiKeyCooldown,
  markGeminiKeyDisabled,
  reserveGeminiDirectKey,
  selectGeminiDirectKey,
} from '../gemini-keys'
import { gptDirectConfigured } from '../gpt-routing'
import { resolveUpstream, type UpstreamRoute } from '../routes'
import type { UpstreamCallResult } from '../shared'
import {
  buildVertexBody,
  isRateLimited,
  modelFallbackRecord,
  VertexTimeCapError,
  withDefaultThinking,
  withVertexRateLimitRetry,
} from '../vertex'
import type { UpstreamExecutionContext, UpstreamExecutor } from './types'

interface GeminiTarget {
  model: string
  url: string
  body: string
  imageSize?: string
  concurrency: UpstreamRoute['concurrency']
}

function readBodyImageSize(
  bodyObj: Record<string, unknown>,
  fallback?: string,
): string | undefined {
  const gc = bodyObj.generationConfig as { imageConfig?: { imageSize?: unknown } } | undefined
  const size = gc?.imageConfig?.imageSize
  return typeof size === 'string' ? size : fallback
}

function upstreamStatusOf(error: unknown): number | undefined {
  const status = (error as { upstreamStatus?: unknown } | null)?.upstreamStatus
  return typeof status === 'number' ? status : undefined
}

/**
 * Vertex 429 回落的目标：只回落到同一个 Vertex 直连上（同一个 baseUrl）的另一个模型，
 * 换到别的上游就要换协议和凭据，不在这次止损的范围里。回落模型不认的分辨率按它自己的声明收口。
 * 找不到、或配成原模型本身时不回落。
 */
function resolveVertexFallback(
  model: string,
  fallbackModel: string | undefined,
  request: HydratedSubmitRequest,
  base: string,
  key: string,
): GeminiTarget | undefined {
  if (!fallbackModel || fallbackModel === model) return undefined
  let route: UpstreamRoute
  try {
    route = resolveUpstream('gemini', fallbackModel)
  } catch {
    return undefined
  }
  if (route.style !== 'vertex-generate-content' || route.baseUrl !== base || route.key !== key)
    return undefined
  const bodyObj = buildVertexBody(withDefaultThinking(request, fallbackModel), route.imageSizes)
  return {
    model: fallbackModel,
    url: `${base}/models/${encodeURIComponent(fallbackModel)}:generateContent`,
    body: JSON.stringify(bodyObj),
    imageSize: readBodyImageSize(bodyObj, request.image_size),
    concurrency: route.concurrency,
  }
}

export const geminiImageExecutor: UpstreamExecutor = {
  id: 'gemini-image',
  matches({ params }) {
    return params.provider === 'gemini'
  },
  async execute(ctx: UpstreamExecutionContext): Promise<UpstreamCallResult> {
    const { params, route, request, session, concurrencyGate } = ctx
    const { provider, model } = params
    const {
      baseUrl: base,
      key,
      style,
      forceB64Json,
      supportsModeration,
      supportsNativeN,
      concurrency,
      imageSizes,
    } = route

    const url = `${base}/models/${encodeURIComponent(model)}:generateContent`
    // Vertex 直连认 Google 自家的 x-goog-api-key；通用网关（sub2api）认 x-api-key。
    const vertex = style === 'vertex-generate-content'
    const buildHeaders = (apiKey: string) => ({
      'content-type': 'application/json',
      ...(apiKey ? { [vertex ? 'x-goog-api-key' : 'x-api-key']: apiKey } : {}),
    })

    const dispatched = planDispatchedImage({
      provider,
      model,
      request,
      style,
      supportsNativeN,
      supportsModeration,
      forceB64Json,
      ...(imageSizes ? { imageSizes } : {}),
      useImageResponses: false,
      member: params.gptMember === true,
      directOn: gptDirectConfigured(model),
    })
    if (!dispatched?.plan.calls[0]) throw new Error(`no image adapter for ${model}`)
    const primaryBodyObj = (dispatched.plan.freshBody?.() ??
      dispatched.plan.calls[0].body) as Record<string, unknown>
    const body = JSON.stringify(primaryBodyObj)
    // 无 DATABASE_URL 的纯内存单测即便宿主环境含 VERTEX_API_KEY 也退回单 key 直发，不依赖数据库表。
    const usePool = vertex && hasGeminiDirectPool() && Boolean(process.env.DATABASE_URL?.trim())

    const throwIfAborted = () => {
      if (session.deadline.timedOut) throw new UpstreamTimeoutError()
      if (session.externalSignal?.aborted) {
        throw session.externalSignal.reason ?? new DOMException('Aborted', 'AbortError')
      }
      if (session.deadline.signal.aborted) {
        throw session.deadline.signal.reason ?? new DOMException('Aborted', 'AbortError')
      }
    }

    const executeSingleFetch = async (
      target: GeminiTarget,
      apiKey: string,
      capAt?: number,
      withRetry = vertex,
      hooks?: {
        onDispatched?: () => void
        onRateLimit?: () => Promise<void>
      },
    ): Promise<UpstreamCallResult> => {
      const capLeftMs = capAt === undefined ? undefined : capAt - Date.now()
      if (capLeftMs !== undefined && capLeftMs <= 0) throw new VertexTimeCapError()
      const queueSignal =
        capLeftMs === undefined
          ? session.deadline.signal
          : AbortSignal.any([session.deadline.signal, AbortSignal.timeout(capLeftMs)])
      const release = target.concurrency
        ? await concurrencyGate
            .acquire(target.concurrency.channelId, target.concurrency.limit, queueSignal)
            .catch((error: unknown) => {
              if (session.deadline.timedOut) throw session.queueTimeoutError()
              if (capAt !== undefined && !session.deadline.signal.aborted && Date.now() >= capAt)
                throw new VertexTimeCapError()
              throw error
            })
        : undefined
      const headers = buildHeaders(apiKey)
      const send = async () => {
        hooks?.onDispatched?.()
        try {
          return await session.parseResponse(
            await session.performFetch(
              target.url,
              { method: 'POST', headers, body: target.body },
              true,
              target.model,
            ),
          )
        } catch (error) {
          if (isRateLimited(error) && hooks?.onRateLimit) await hooks.onRateLimit()
          throw error
        }
      }
      try {
        return withRetry
          ? await withVertexRateLimitRetry(
              send,
              session.deadline.signal,
              () => session.deadline.timedOut,
              capAt,
              {
                ...(params.taskId ? { taskId: params.taskId } : {}),
                model: target.model,
              },
            )
          : await send()
      } finally {
        release?.()
      }
    }

    const sendViaPool = async (
      target: GeminiTarget,
      capAt?: number,
    ): Promise<UpstreamCallResult> => {
      const estimate = estimateGeminiCostMicroUsd(target.model, target.imageSize, 1)
      const exclude = new Set<string>()
      let lastError: unknown

      while (true) {
        throwIfAborted()
        let reserved = await reserveGeminiDirectKey({ estimateMicroUsd: estimate, exclude })
        let usedCooldownFallback = false
        if (!reserved) {
          // 常规选钥无可用（含前一把刚失效/冷却后其余都在 429 冷却）时，在未排除集合内允许借冷却中
          // 且未超预算、未停用的 key 继续走退避与模型回落；全部超预算或停用则仍返回 null。
          reserved = await reserveGeminiDirectKey({
            estimateMicroUsd: estimate,
            exclude,
            allowCooldown: true,
          })
          usedCooldownFallback = reserved !== null
        }
        if (!reserved) {
          throwIfAborted()
          if (lastError !== undefined) throw lastError
          log.error(
            { event: 'gemini.direct_keys_exhausted', model: target.model },
            'all gemini direct keys are disabled or over monthly budget',
          )
          throw new GeminiDirectKeysExhaustedError()
        }
        const { key: activeKey, reservationId } = reserved
        exclude.add(activeKey.fingerprint)

        const another = await selectGeminiDirectKey({
          estimateMicroUsd: estimate,
          exclude,
          allowCooldown: usedCooldownFallback,
        })
        const hasNextKey = another !== null

        let reservationSettled = false
        let requestDispatched = false
        try {
          const result = await executeSingleFetch(target, activeKey.secret, capAt, !hasNextKey, {
            onDispatched: () => {
              requestDispatched = true
            },
            ...(hasNextKey
              ? {}
              : {
                  onRateLimit: async () => {
                    await markGeminiKeyCooldown(activeKey, { upstreamStatus: 429 })
                    await recordGeminiUsage({
                      ...(params.taskId ? { taskId: params.taskId } : {}),
                      model: target.model,
                      ...(target.imageSize ? { imageSize: target.imageSize } : {}),
                      images: 0,
                      status: 'rate_limited',
                      upstreamStatus: 429,
                      keyFingerprint: activeKey.fingerprint,
                    })
                  },
                }),
          })
          // 请求已成功出图：即便落账写库失败也不应释放预占，留着预占到租期结束守住月预算。
          reservationSettled = true
          await recordGeminiUsage({
            ...(params.taskId ? { taskId: params.taskId } : {}),
            model: target.model,
            ...(target.imageSize ? { imageSize: target.imageSize } : {}),
            images: 1,
            status: 'ok',
            upstreamStatus: 200,
            keyFingerprint: activeKey.fingerprint,
            payload: result.payload,
            reservationId,
          })
          return result
        } catch (error) {
          lastError = error
          const failure = classifyGeminiKeyFailure(error)
          const status = upstreamStatusOf(error)
          if (failure === 'cooldown' && hasNextKey) {
            await markGeminiKeyCooldown(activeKey, error)
            reservationSettled = await recordGeminiUsage({
              ...(params.taskId ? { taskId: params.taskId } : {}),
              model: target.model,
              ...(target.imageSize ? { imageSize: target.imageSize } : {}),
              images: 0,
              status: 'rate_limited',
              ...(status !== undefined ? { upstreamStatus: status } : {}),
              keyFingerprint: activeKey.fingerprint,
              reservationId,
            })
            log.warn(
              {
                event: 'gemini.direct_key_cooldown_switch',
                fingerprint: activeKey.label,
                model: target.model,
              },
              'gemini direct key hit 429, switching to next key',
            )
            continue
          }
          if (failure === 'invalid' || failure === 'quota') {
            await markGeminiKeyDisabled(activeKey, failure, error)
            reservationSettled = await recordGeminiUsage({
              ...(params.taskId ? { taskId: params.taskId } : {}),
              model: target.model,
              ...(target.imageSize ? { imageSize: target.imageSize } : {}),
              images: 0,
              status: 'error',
              ...(status !== undefined ? { upstreamStatus: status } : {}),
              keyFingerprint: activeKey.fingerprint,
              reservationId,
            })
            log.warn(
              {
                event: 'gemini.direct_key_disabled_switch',
                fingerprint: activeKey.label,
                reason: failure,
                model: target.model,
              },
              'gemini direct key disabled, trying next key',
            )
            continue
          }
          // 未出队列就取消或超时：请求从未发往 Vertex，不计入密钥统计，直接释放预占。
          if (!requestDispatched) {
            throw error
          }
          // 已派发但超时/断连结果未知：按估算计入本月花费守住预算；写库失败时保留预占直到租期。
          if (
            error instanceof UpstreamResultUnknownError ||
            error instanceof UpstreamTimeoutError
          ) {
            reservationSettled = true
            await recordGeminiUsage({
              ...(params.taskId ? { taskId: params.taskId } : {}),
              model: target.model,
              ...(target.imageSize ? { imageSize: target.imageSize } : {}),
              images: 1,
              status: 'error',
              billUnknown: true,
              keyFingerprint: activeKey.fingerprint,
              reservationId,
            })
            throw error
          }
          // 429 在 !hasNextKey 分支已由 onRateLimit 记过 rate_limited，这里由 finally 释放预占；
          // 其它已派发错误（如 400 / 5xx）记一条 error；若记账写库失败则由 finally 兜底释放预占。
          if (!isRateLimited(error) && !(error instanceof VertexTimeCapError)) {
            reservationSettled = await recordGeminiUsage({
              ...(params.taskId ? { taskId: params.taskId } : {}),
              model: target.model,
              ...(target.imageSize ? { imageSize: target.imageSize } : {}),
              images: 0,
              status: 'error',
              ...(status !== undefined ? { upstreamStatus: status } : {}),
              keyFingerprint: activeKey.fingerprint,
              reservationId,
            })
          }
          throw error
        } finally {
          if (!reservationSettled) {
            await releaseGeminiReservation(reservationId)
          }
        }
      }
    }

    const sendVia = (target: GeminiTarget, capAt?: number) =>
      usePool ? sendViaPool(target, capAt) : executeSingleFetch(target, key, capAt, vertex)

    const primary: GeminiTarget = {
      model,
      url,
      body,
      imageSize: readBodyImageSize(primaryBodyObj, request.image_size),
      concurrency,
    }
    const fallback = vertex
      ? resolveVertexFallback(model, params.rateLimitFallbackModel, request, base, key)
      : undefined
    const capAt = fallback ? params.rateLimitFallbackAt : undefined
    let fallbackImages = 0
    const merge = (results: UpstreamCallResult[]) => {
      const merged = mergeGeminiCandidateResults(results)
      if (!fallback || fallbackImages === 0) return merged
      return {
        payload: {
          ...(merged.payload as Record<string, unknown>),
          model_fallback: modelFallbackRecord(model, fallback.model, fallbackImages),
        },
      }
    }
    const result = await fanOutRequests(
      request.n,
      async () => {
        try {
          return await sendVia(primary, capAt)
        } catch (error) {
          const capped = error instanceof VertexTimeCapError
          if (!fallback || !(capped || isRateLimited(error)) || session.deadline.signal.aborted)
            throw error
          log.warn(
            {
              event: 'upstream.vertex_rate_limit_fallback',
              requestedModel: model,
              fallbackModel: fallback.model,
              reason: capped ? 'time_cap' : 'rate_limited',
            },
            'vertex rate limit exhausted, falling back',
          )
          const fallbackResult = await sendVia(fallback)
          fallbackImages += 1
          return fallbackResult
        }
      },
      (results) => merge(results),
      params.reconciliationRequired,
      session.cancelled,
    ).then((merged) =>
      (request.n ?? 1) <= 1 && fallback && fallbackImages > 0 ? merge([merged]) : merged,
    )
    return stampReceipt(result, dispatched.plan)
  },
}
