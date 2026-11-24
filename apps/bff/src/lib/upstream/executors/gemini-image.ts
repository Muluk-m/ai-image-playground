import type { HydratedSubmitRequest } from '../../imageArchive'
import { log } from '../../logger'
import { planDispatchedImage, stampReceipt } from '../adapters'
import { fanOutRequests } from '../fanout'
import { mergeGeminiCandidateResults } from '../gemini'
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

/**
 * Vertex 429 回落的目标：只回落到同一个 Vertex 直连上（同一个 key、同一个 baseUrl）的另一个模型，
 * 换到别的上游就要换协议和凭据，不在这次止损的范围里。回落模型不认的分辨率按它自己的声明收口。
 * 找不到、或配成原模型本身时不回落。
 */
function resolveVertexFallback(
  model: string,
  fallbackModel: string | undefined,
  request: HydratedSubmitRequest,
  base: string,
  key: string,
):
  | { model: string; url: string; body: string; concurrency: UpstreamRoute['concurrency'] }
  | undefined {
  if (!fallbackModel || fallbackModel === model) return undefined
  let route: UpstreamRoute
  try {
    route = resolveUpstream('gemini', fallbackModel)
  } catch {
    return undefined
  }
  if (route.style !== 'vertex-generate-content' || route.baseUrl !== base || route.key !== key)
    return undefined
  return {
    model: fallbackModel,
    url: `${base}/models/${encodeURIComponent(fallbackModel)}:generateContent`,
    body: JSON.stringify(
      buildVertexBody(withDefaultThinking(request, fallbackModel), route.imageSizes),
    ),
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
    const headers = {
      'content-type': 'application/json',
      ...(key ? { [vertex ? 'x-goog-api-key' : 'x-api-key']: key } : {}),
    }
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
    const body = JSON.stringify(dispatched.plan.freshBody?.() ?? dispatched.plan.calls[0].body)

    // Gemini image generation 不支持 candidateCount>1（"Only one candidate is
    // supported for audio or image response"），n>1 时本层 fan-out 成 N 条单张请求
    // 并把 candidates 合并到一个 payload，对 task-runner / 前端透明。声明了 maxConcurrency
    // （Vertex 按模型各配 2）时，每条请求先排「渠道/模型」或渠道级的队再发。
    const sendVia = async (
      target: {
        model: string
        url: string
        body: string
        concurrency: UpstreamRoute['concurrency']
      },
      /** 原模型的总时限：到点不再排队、不再退避，抛 {@link VertexTimeCapError} 交给回落。 */
      capAt?: number,
    ) => {
      // 剩余时间只读一次：检查和建定时器之间跨过时限也不会给 AbortSignal.timeout 传负数。
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
              // 排队时就超时：这条请求没发出去，确定未执行，不是「结果未知」。
              if (session.deadline.timedOut) throw session.queueTimeoutError()
              if (capAt !== undefined && !session.deadline.signal.aborted && Date.now() >= capAt)
                throw new VertexTimeCapError()
              throw error
            })
        : undefined
      const send = async () =>
        await session.parseResponse(
          await session.performFetch(
            target.url,
            { method: 'POST', headers, body: target.body },
            true,
            target.model,
          ),
        )
      try {
        // Vertex 的 429 是按模型的到达速率限流：先在这条请求里退避重发，一单多张里已出的图不必重来。
        return vertex
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

    const primary = { model, url, body, concurrency }
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
          // 退避用完仍 429、或原模型到了总时限：这一张换回落模型补上（它有自己的排队位与退避）；
          // 别的错误照原样抛。
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
      // 单张请求（n=1）不经过 merge：回落出的那张也要记下实际模型。
      (request.n ?? 1) <= 1 && fallback && fallbackImages > 0 ? merge([merged]) : merged,
    )
    return stampReceipt(result, dispatched.plan)
  },
}
