import type { HydratedSubmitRequest } from '../../imageArchive'
import { log } from '../../logger'
import { planDispatchedImage, stampReceipt } from '../adapters'
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
    const usePool = vertex && hasGeminiDirectPool()

    const executeSingleFetch = async (
      target: GeminiTarget,
      apiKey: string,
      capAt?: number,
      withRetry = vertex,
      onRateLimit?: () => Promise<void>,
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
          if (isRateLimited(error) && onRateLimit) await onRateLimit()
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

      while (!session.deadline.signal.aborted) {
        let reserved = await reserveGeminiDirectKey({ estimateMicroUsd: estimate, exclude })
        let usedCooldownFallback = false
        if (!reserved && exclude.size === 0) {
          // 所有未超预算且未停用的 key 都在 429 冷却中时，挑一把继续走退避重试与模型回落，
          // 而不是因为瞬时冷却把整单直接硬拒；若全部超预算/停用则依然返回 null 报错。
          reserved = await reserveGeminiDirectKey({
            estimateMicroUsd: estimate,
            exclude,
            allowCooldown: true,
          })
          usedCooldownFallback = reserved !== null
        }
        if (!reserved) {
          if (lastError !== undefined) throw lastError
          throw new GeminiDirectKeysExhaustedError()
        }
        const { key: activeKey, reservationId } = reserved
        exclude.add(activeKey.fingerprint)

        const another = usedCooldownFallback
          ? null
          : await selectGeminiDirectKey({ estimateMicroUsd: estimate, exclude })
        const hasNextKey = another !== null

        let reservationSettled = false
        try {
          const result = await executeSingleFetch(
            target,
            activeKey.secret,
            capAt,
            !hasNextKey,
            hasNextKey
              ? undefined
              : async () => {
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
          )
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
            reservationSettled = true
            await recordGeminiUsage({
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
            reservationSettled = true
            await recordGeminiUsage({
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
          // 429 在 !hasNextKey 分支已由 onRateLimit 记过 rate_limited，这里只释放预占；
          // 其它错误（非 429、非 VertexTimeCapError）记一次 error 并释放预占。
          if (!reservationSettled) {
            reservationSettled = true
            if (isRateLimited(error) || error instanceof VertexTimeCapError) {
              await releaseGeminiReservation(reservationId)
            } else {
              await recordGeminiUsage({
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
          }
          throw error
        } finally {
          if (!reservationSettled) {
            await releaseGeminiReservation(reservationId)
          }
        }
      }
      throw lastError ?? new GeminiDirectKeysExhaustedError()
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
