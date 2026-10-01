import { Buffer } from 'node:buffer'
import { QUEUE_TIMEOUTS, type QueueProvider } from '@image-playground/shared'
import { config } from '../config'
import { getChannels } from './channels'
import type { HydratedSubmitRequest } from './imageArchive'
import { log } from './logger'
import {
  buildImageResponsesBody,
  ImageResponsesError,
  readImageResponses,
} from './openaiImageResponses'
import { resolveApiKey } from './resolveApiKey'
import {
  createDispatcher,
  createFetchSlot,
  startDeadline,
  type UndiciFetchInit,
  type UndiciFetchInput,
} from './timeoutFetch'
import {
  type AsyncTaskProtocol,
  asyncTaskFailure,
  imageTaskProtocol,
  isRecoverablePollFailure,
  warnIfAsyncTasksDisabled,
} from './upstream/async-tasks'
import {
  extractErrorMessage,
  stringifyUpstreamPayload,
  UpstreamPartialResultError,
  UpstreamResultUnknownError,
  UpstreamTimeoutError,
} from './upstream/errors'
import { buildGeminiBody, mergeGeminiCandidateResults } from './upstream/gemini'
import {
  buildGrokEditBody,
  buildGrokImagine2Body,
  isGrokImagine2,
  normalizeGrokEditInputs,
  normalizeGrokImagine2EditInputs,
} from './upstream/grok'
import {
  buildAgnesGenerationsBody,
  buildOpenAIBody,
  buildOpenAIEditFormData,
  isGptImageModel,
  mergeOpenAIDataResults,
  mergeOpenAIImageResults,
  withoutImageCount,
  withoutModeration,
} from './upstream/openai'
import { type ChannelRouteStyle, clientError, type UpstreamCallResult } from './upstream/shared'
import { VIDEO_MIME, VIDEO_STYLE_SPECS } from './upstream/video'

/*
 * 把排队任务发给上游：按 channel 路由、硬超时、计费回调、fan-out、异步任务的提交与恢复。
 * 各服务商的请求体、结果解析与异步任务协议在 `./upstream/` 下。BFF 不翻译模型参数。
 */

const CHANNEL_ROUTE_STYLES: Readonly<Record<string, ChannelRouteStyle | undefined>> = {
  'agnes-images': 'agnes-generations-json',
  'grok-images': 'grok-openai-images',
  'grok-video': 'grok-videos',
  'agnes-video': 'agnes-videos',
  'ark-video': 'ark-videos',
  'veo-video': 'veo-videos',
}

interface UpstreamRoute {
  baseUrl: string
  key: string
  /** openai-compat 分支的协议风格（gemini 分支不看这个字段）。 */
  style: ChannelRouteStyle
  /** channel 声明只接受 base64 结果（gemini 分支不看这个字段）。 */
  forceB64Json: boolean
  /** 模型声明了 moderation 能力；未声明的剥掉再发，别赌上游会忽略未知字段。 */
  supportsModeration: boolean
  /** 上游提供 sub2api 风格的异步图片任务端点。 */
  asyncTasks: boolean
  /** 上游原生支持 n；一条请求即可返回多张图，不应在 BFF 内 fan-out。 */
  supportsNativeN: boolean
}

/**
 * provider + model → 上游 baseUrl、API key 与协议风格。
 * 返回的 baseUrl 统一**含版本段**（如 .../v1、.../v1beta），调用方拼相对路径，
 * 杜绝 channel baseUrl（含版本段）与 env baseUrl（不含）两套约定打架拼出 /v1/v1。
 * 未命中 CHANNEL_ROUTE_STYLES 的走 UPSTREAM_BASE_URL 通用网关 + 标准 OpenAI 协议。
 */
function resolveUpstream(provider: QueueProvider, model: string): UpstreamRoute {
  const kind = provider === 'gemini' ? 'gemini-queue' : 'openai-queue'
  for (const channel of getChannels()) {
    const style = CHANNEL_ROUTE_STYLES[channel.id]
    if (!style || channel.kind !== kind) continue
    const declared = channel.models.find((m) => m.id === model)
    if (!declared) continue
    return {
      baseUrl: channel.baseUrl,
      key: channel.auth.secret,
      style,
      forceB64Json: provider === 'openai-compat' && channel.defaults.responseFormatB64Json === true,
      supportsModeration: declared.capabilities.includes('moderation'),
      asyncTasks: provider === 'openai-compat' && channel.defaults.asyncTasks === true,
      supportsNativeN: provider === 'openai-compat' && declared.capabilities.includes('n'),
    }
  }
  const version = provider === 'gemini' ? 'v1beta' : 'v1'
  return {
    baseUrl: `${config.upstream.baseUrl}/${version}`,
    key: resolveApiKey(provider),
    style: 'openai-images',
    forceB64Json: false,
    supportsModeration: true,
    asyncTasks: provider === 'openai-compat' && config.upstream.asyncImageTasks,
    // 通用网关未声明原生多图能力；模型名不能证明当前上游会兑现 n。
    supportsNativeN: false,
  }
}

export interface UpstreamCallParams {
  /** New producers must preserve any unknown branch, irrespective of rejection order. */
  reconciliationRequired?: boolean
  provider: QueueProvider
  model: string
  request: HydratedSubmitRequest
  signal?: AbortSignal
  /** Runs immediately before each upstream invocation is dispatched. Polling does not count. */
  beforeRequest?: () => Promise<string | void>
  onRequestDispatched?: (dispatchId: string) => Promise<void>
  onRequestId?: (dispatchId: string, requestId: string) => Promise<void>
  onUpstreamTaskId?: (dispatchId: string, taskId: string) => Promise<void>
  /** 异步提交拿到 id 后、开始轮询**之前**调用；必须在这一步之内把 id 持久化。 */
  onUpstreamTaskIds?: (taskIds: readonly string[]) => Promise<void>
  /** 本任务已提交过的上游异步任务：这些 id 只轮询，永不重提。 */
  resume?: UpstreamResume
}

export interface UpstreamResume {
  readonly pollOnly?: boolean
  readonly taskIds: readonly string[]
  /** 已派发的请求数；路由升级不能把旧 fan-out 的缺失提交认成完整原生批次。 */
  readonly invocationCount?: number
  /** 首次提交时刻，超时预算的锚点；重启不能重新发一份完整预算。 */
  readonly submittedAt: number
}

interface UpstreamResponse {
  readonly ok: boolean
  readonly headers?: { get(name: string): string | null }
  readonly status: number
  readonly body?: ReadableStream<Uint8Array> | null
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}

type UpstreamFetch = (input: UndiciFetchInput, init?: UndiciFetchInit) => Promise<UpstreamResponse>

type UpstreamFetchInit = UndiciFetchInit

export const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000

export const UPSTREAM_TRANSPORT_TIMEOUT_MS = QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS + 60_000

const upstreamDispatcher = createDispatcher({
  connectMs: UPSTREAM_CONNECT_TIMEOUT_MS,
  transportMs: UPSTREAM_TRANSPORT_TIMEOUT_MS,
})

const upstreamTransport = createFetchSlot<UpstreamFetch>()

export function setUpstreamFetchForTesting(fetchImpl?: UpstreamFetch): void {
  upstreamTransport.set(fetchImpl)
}

/**
 * Bun fetch 的 client timeout 无法可靠覆盖，改用 Undici Agent 的公开配置项。
 * transport headers/body 都比应用硬超时长 1min，确保正常终止统一由下方
 * AbortController 决定；不再依赖 undocumented idleTimeout 或强制 Connection: close。
 */
export async function callUpstream(params: UpstreamCallParams): Promise<UpstreamCallResult> {
  const {
    provider,
    model,
    signal: externalSignal,
    beforeRequest,
    onUpstreamTaskIds,
    resume,
  } = params
  const {
    baseUrl: base,
    key,
    style,
    forceB64Json,
    supportsModeration,
    asyncTasks,
    supportsNativeN,
  } = resolveUpstream(provider, model)
  let request = params.request
  // 原生 n 只适用于无参考图的 Images generations；Responses 图片工具不接受 tools[].n。
  const requestedImageCount = Math.max(1, request.n ?? 1)
  const useNativeN =
    provider === 'openai-compat' &&
    style === 'openai-images' &&
    supportsNativeN &&
    requestedImageCount > 1 &&
    !request.input_images?.length &&
    !request.mask
  // Grok 回的 imgen.x.ai URL 对服务器出口 IP 一律 403（带 Bearer 也 403），归档取不到图。
  if (forceB64Json) {
    request = { ...request, extra: { ...request.extra, response_format: 'b64_json' } }
  }
  if (!supportsModeration) request = withoutModeration(request)

  const deadlineAt = (resume?.submittedAt ?? Date.now()) + QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS
  // A resumed task may have completed while its worker was unavailable. Give the
  // read-only final lookup a bounded transport window, never a new generation budget.
  const finalLookup = Boolean(resume?.taskIds.length) && Date.now() >= deadlineAt
  const deadline = startDeadline(finalLookup ? 20_000 : deadlineAt - Date.now(), externalSignal)

  const fetchInit = (init: UpstreamFetchInit): UpstreamFetchInit => ({
    ...init,
    signal: deadline.signal,
    dispatcher: upstreamDispatcher,
  })

  /**
   * `counted` 区分「一次上游调用」与「一次轮询」：只有前者过记账回调。异步模式下
   * 轮询次数与计费无关，混进去会让 upstream_invocation_count 失去意义。
   */
  const dispatchIdentities = new WeakMap<UpstreamResponse, string>()
  const performFetch = async (
    url: string,
    init: UpstreamFetchInit,
    counted = true,
  ): Promise<UpstreamResponse> => {
    try {
      if (deadline.signal.aborted) throw new DOMException('Upstream request aborted', 'AbortError')
      const dispatchId = counted ? await beforeRequest?.() : undefined

      // The accounting callback is the dispatch commit point. Start the transport with a fresh
      // signal before relaying cancellation so a cancellation that loses the database race cannot
      // create a charged task without a corresponding upstream invocation.
      const requestAbort = new AbortController()
      const relayAbort = () => requestAbort.abort()
      const responsePromise = upstreamTransport.current(url, {
        ...fetchInit(init),
        signal: requestAbort.signal,
      })
      deadline.signal.addEventListener('abort', relayAbort, { once: true })
      if (deadline.signal.aborted) relayAbort()
      try {
        const recorded = dispatchId ? params.onRequestDispatched?.(dispatchId) : undefined
        let response: UpstreamResponse
        try {
          ;[response] = await Promise.all([responsePromise, recorded])
        } catch (error) {
          requestAbort.abort()
          throw error
        }
        if (dispatchId) dispatchIdentities.set(response, dispatchId)
        const requestId =
          response.headers?.get('x-request-id') ?? response.headers?.get('request-id')
        if (dispatchId && requestId) await params.onRequestId?.(dispatchId, requestId)
        return response
      } finally {
        deadline.signal.removeEventListener('abort', relayAbort)
      }
    } catch (err) {
      if (deadline.timedOut) throw new UpstreamTimeoutError()
      if (externalSignal?.aborted) throw err
      const detail = err instanceof Error ? err.message : String(err)
      throw new UpstreamResultUnknownError(`上游连接中断，执行结果未知：${detail}`, {
        cause: err,
      })
    }
  }

  const parseResponse = async (
    res: UpstreamResponse,
    imageResponses = false,
  ): Promise<UpstreamCallResult> => {
    try {
      return imageResponses && res.ok
        ? { payload: await readImageResponses(res.body, deadline.signal) }
        : await parseUpstreamResponse(res)
    } catch (err) {
      if (deadline.timedOut) throw new UpstreamTimeoutError()
      if (externalSignal?.aborted) throw err
      if (err instanceof ImageResponsesError) throw err
      if (typeof (err as { upstreamStatus?: unknown })?.upstreamStatus === 'number') throw err
      const detail = err instanceof Error ? err.message : String(err)
      throw new UpstreamResultUnknownError(`上游响应中断，执行结果未知：${detail}`, {
        cause: err,
      })
    }
  }

  // 这个 try 里每个 return 都必须 `return await`：裸 return 一个 promise 会让下面的
  // finally 立刻跑，请求还在飞的时候就 release 掉 deadline —— 取消与硬超时都会静默失效。
  try {
    if (provider === 'openai-compat') {
      const authHeader = upstreamAuthHeader(style, key)
      const resumeIds = resume?.taskIds ?? []
      const useAsyncTasks = asyncTasks || resumeIds.length > 0

      /**
       * 补齐到 count 个上游任务：已有 id 原样带出，只为缺口发提交请求。上游没有幂等键，
       * 重提已落库的 id 就是第二次计费，所以缺口是唯一可以提交的份额。
       */
      const collectTaskIds = async (
        protocol: AsyncTaskProtocol,
        count: number,
        makeInit: () => UpstreamFetchInit,
      ): Promise<string[]> => {
        const missing = count - resumeIds.length
        if (missing <= 0) return [...resumeIds]
        if (finalLookup || resume?.pollOnly) return [...resumeIds]
        const settled = await Promise.allSettled(
          Array.from({ length: missing }, async () => {
            const response = await performFetch(protocol.submitUrl, makeInit())
            const taskId = protocol.readTaskId((await parseResponse(response)).payload)
            const dispatchId = dispatchIdentities.get(response)
            if (dispatchId) await params.onUpstreamTaskId?.(dispatchId, taskId)
            return taskId
          }),
        )
        const taskIds = [
          ...resumeIds,
          ...settled.flatMap((one) => (one.status === 'fulfilled' ? [one.value] : [])),
        ]
        // 先落库再抛：部分失败时成功那几个已经计费，丢了 id 就没人收。
        if (taskIds.length > resumeIds.length) await onUpstreamTaskIds?.(taskIds)
        const failure = fanOutFailure(settled, params.reconciliationRequired)
        if (failure) {
          warnIfAsyncTasksDisabled(failure.reason)
          if (params.reconciliationRequired && taskIds.length > 0) {
            const detail =
              failure.reason instanceof Error ? failure.reason.message.slice(0, 200) : '提交失败'
            throw new UpstreamResultUnknownError(
              `部分提交被拒绝，已受理任务的最终结果待核查：${detail}`,
              { cause: failure.reason },
            )
          }
          throw failure.reason
        }
        return taskIds
      }

      /** 硬超时会 abort 掉轮询的 sleep；不映射的话裸 AbortError 会被当成用户取消，行没有终态。 */
      const pollDelay = async (attempt: number): Promise<void> => {
        try {
          await abortableSleep(asyncPollDelayMs(attempt), deadline.signal)
        } catch (err) {
          if (deadline.timedOut) throw new UpstreamTimeoutError()
          throw err
        }
      }

      /** 轮询单个上游任务到终态。判定与提交侧方向相反：瞬时错误一律继续轮。 */
      const pollAsyncTask = async (
        protocol: AsyncTaskProtocol,
        taskId: string,
      ): Promise<UpstreamCallResult> => {
        const pollUrl = protocol.pollUrl(taskId)
        for (let attempt = 0; ; attempt++) {
          if (Date.now() >= deadlineAt && !(finalLookup && attempt === 0))
            throw new UpstreamTimeoutError()
          let payload: unknown
          try {
            payload = (
              await parseResponse(
                await performFetch(pollUrl, { method: 'GET', headers: authHeader }, false),
              )
            ).payload
          } catch (err) {
            if (deadline.timedOut || externalSignal?.aborted || !isRecoverablePollFailure(err))
              throw err
            // 留 payload 为 undefined，下面按 pending 走同一条退避路径。
          }
          const state = protocol.readState(payload)
          if (state.kind === 'completed') return { payload: state.payload }
          if (state.kind === 'failed') throw asyncTaskFailure(state.status, payload)
          if (finalLookup) throw new UpstreamTimeoutError()
          await pollDelay(attempt)
        }
      }

      /**
       * 一次逻辑调用 → count 个上游请求 → 合并。同步模式直接发；异步模式提交后转轮询。
       * count 是上游请求数，不是产图数；原生 n 只派发一次，其余路径逐图 fan-out。
       * 恢复时保留已派发数量，避免新路由掩盖旧任务缺失的提交结果。
       */
      const dispatch = async (
        url: string,
        count: number,
        makeInit: () => UpstreamFetchInit,
        merge: (results: UpstreamCallResult[]) => UpstreamCallResult,
      ): Promise<UpstreamCallResult> => {
        if (!useAsyncTasks) {
          return fanOutRequests(
            count,
            async () => parseResponse(await performFetch(url, makeInit())),
            merge,
            params.reconciliationRequired,
          )
        }
        const protocol = imageTaskProtocol(base, url)
        // 已提交任务只恢复当时的调用数，不能按新路由补发或误判旧原生批次。
        const expectedCount = resume?.invocationCount ?? count
        const taskIds = await collectTaskIds(protocol, expectedCount, makeInit)
        const results = await collectFanOutResults(
          taskIds.map((id) => pollAsyncTask(protocol, id)),
          params.reconciliationRequired,
        )
        const result = results.length === 1 ? results[0]! : merge(results)
        if (taskIds.length < expectedCount) throw new UpstreamPartialResultError(result.payload)
        return result
      }

      const videoSpec = VIDEO_STYLE_SPECS[style]
      if (videoSpec) {
        const video = request.video
        if (!video) throw clientError('视频任务缺少视频参数')
        const mode = video.mode ?? 'generate'
        if (!videoSpec.modes.includes(mode)) throw clientError('该模型不支持续写和改视频')
        const protocol = videoSpec.protocol({ base, model, mode })
        const headers = { 'content-type': 'application/json', ...authHeader }
        const [taskId] = await collectTaskIds(protocol, 1, () => ({
          method: 'POST',
          headers,
          body: JSON.stringify(videoSpec.body(model, request, video, mode)),
        }))
        const { payload } = await pollAsyncTask(protocol, taskId!)
        const outcome = videoSpec.result(base, payload, video)
        const duration_seconds = outcome.durationSeconds
        if (outcome.kind === 'public')
          return { payload: { data: [{ url: outcome.url, mime: VIDEO_MIME, duration_seconds }] } }

        const res = await performFetch(outcome.url, { method: 'GET', headers: authHeader }, false)
        if (!res.ok) await parseResponse(res)
        const bytes = Buffer.from(await res.arrayBuffer())
        return {
          payload: {
            data: [{ b64_json: bytes.toString('base64'), mime: VIDEO_MIME, duration_seconds }],
          },
        }
      }

      if (
        !useNativeN &&
        style === 'openai-images' &&
        isGptImageModel(model) &&
        config.upstream.imageResponsesModel &&
        resumeIds.length === 0
      ) {
        const body = JSON.stringify(
          buildImageResponsesBody(config.upstream.imageResponsesModel, model, request),
        )
        const headers = {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...authHeader,
        }
        return await fanOutRequests(
          request.n,
          async () =>
            parseResponse(
              await performFetch(`${base}/responses`, { method: 'POST', headers, body }),
              true,
            ),
          mergeOpenAIImageResults,
          params.reconciliationRequired,
        )
      }

      // Agnes 风格上游：没有 images/edits 端点，图生图与文生图
      // 共用 images/generations JSON，输入图放 extra_body.image（data URI / URL）。
      // 实测注意：文档"Important Notes"声称的 top-level image 数组会被上游**静默忽略**
      // （跑成纯文生图），必须放 extra_body；n 同样被忽略，这里学 gemini 分支 fan-out。
      if (style === 'agnes-generations-json') {
        if (request.mask) {
          throw clientError('该模型不支持遮罩编辑（上游无 mask 能力），请换 GPT 模型或去掉遮罩')
        }
        const body = JSON.stringify(buildAgnesGenerationsBody(model, request))
        const headers = { 'content-type': 'application/json', ...authHeader }
        return await dispatch(
          `${base}/images/generations`,
          Math.max(1, request.n ?? 1),
          () => ({ method: 'POST', headers, body }),
          mergeOpenAIDataResults,
        )
      }

      // 有参考图 / 有遮罩 → images/edits；generations 是纯文生图，
      // 塞 input_images 字段上游会忽略（用户感知"AI 不参考附件"）。
      if (request.input_images?.length || request.mask) {
        // Grok 1.0 多张参考图先合成 contact sheet；2.0 原生多图，跳过拼图。
        let editRequest = request
        if (style === 'grok-openai-images') {
          editRequest = isGrokImagine2(model)
            ? normalizeGrokImagine2EditInputs(request)
            : await normalizeGrokEditInputs(request, deadline.signal)
        }
        const n = Math.max(1, editRequest.n ?? 1)
        const unitRequest = n === 1 ? editRequest : withoutImageCount(editRequest)
        // Grok edits 必须 application/json：改回 multipart 会被 sub2api 转换丢掉
        // response_format，上游退回 URL 结果，归档取图一律 403。
        // FormData 会被请求消费掉，所以只有 JSON 体能在 fan-out 之间复用。
        const grokBody =
          style === 'grok-openai-images'
            ? JSON.stringify(buildGrokEditBody(model, unitRequest))
            : null
        const makeInit = (): UpstreamFetchInit =>
          grokBody !== null
            ? {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...authHeader },
                body: grokBody,
              }
            : {
                method: 'POST',
                headers: authHeader,
                body: buildOpenAIEditFormData(model, unitRequest),
              }
        return await dispatch(`${base}/images/edits`, n, makeInit, mergeOpenAIImageResults)
      }

      const headers = { 'content-type': 'application/json', ...authHeader }
      const n = Math.max(1, request.n ?? 1)
      // 原生 n 是一次上游生成请求；否则沿用兼容网关的单图 fan-out。
      const unitRequest = useNativeN || n === 1 ? request : withoutImageCount(request)
      const body = JSON.stringify(
        style === 'grok-openai-images' && isGrokImagine2(model)
          ? buildGrokImagine2Body(model, unitRequest)
          : buildOpenAIBody(model, unitRequest),
      )
      return await dispatch(
        `${base}/images/generations`,
        useNativeN ? 1 : n,
        () => ({ method: 'POST', headers, body }),
        mergeOpenAIImageResults,
      )
    }

    if (provider === 'gemini') {
      const url = `${base}/models/${encodeURIComponent(model)}:generateContent`
      const headers = {
        'content-type': 'application/json',
        ...(key ? { 'x-api-key': key } : {}),
      }
      const body = JSON.stringify(buildGeminiBody(request))

      // Gemini image generation 不支持 candidateCount>1（"Only one candidate is
      // supported for audio or image response"），n>1 时本层 fan-out 成 N 次并发
      // 请求并把 candidates 合并到一个 payload，对 task-runner / 前端透明。
      return await fanOutRequests(
        request.n,
        async () => {
          const res = await performFetch(url, { method: 'POST', headers, body })
          return parseResponse(res)
        },
        mergeGeminiCandidateResults,
        params.reconciliationRequired,
      )
    }
    throw new Error(`Unsupported provider: ${provider satisfies never}`)
  } catch (err) {
    // fan-out 请求任一失败时取消其它同批请求，避免 callUpstream 已返回失败后仍在后台跑。
    deadline.abort()
    throw err
  } finally {
    deadline.release()
  }
}

/** 轮询退避（ms），index 超出取末位。上游 202 响应的 `Retry-After` 也是 3。 */
const ASYNC_POLL_BACKOFF_MS: readonly number[] = [3_000, 3_000, 5_000, 5_000, 10_000]

let asyncPollBackoffMs = ASYNC_POLL_BACKOFF_MS

/** 测试注入点；undefined 恢复真实退避（否则一次重试就要真睡 3 秒）。 */
export function setAsyncPollBackoffForTesting(backoffMs?: readonly number[]): void {
  asyncPollBackoffMs = backoffMs ?? ASYNC_POLL_BACKOFF_MS
}

function asyncPollDelayMs(attempt: number): number {
  return asyncPollBackoffMs[Math.min(attempt, asyncPollBackoffMs.length - 1)]!
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Upstream polling aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function fanOutRequests(
  requestedCount: number | undefined,
  run: () => Promise<UpstreamCallResult>,
  merge: (results: UpstreamCallResult[]) => UpstreamCallResult,
  reconciliationRequired = false,
): Promise<UpstreamCallResult> {
  const count = Math.max(1, requestedCount ?? 1)
  if (count === 1) return run()
  return merge(
    await collectFanOutResults(Array.from({ length: count }, run), reconciliationRequired),
  )
}

function fanOutFailure<T>(settled: PromiseSettledResult<T>[], preserveUnknown = false) {
  const failures = settled.filter((one): one is PromiseRejectedResult => one.status === 'rejected')
  return (
    (preserveUnknown
      ? failures.find((one) => one.reason instanceof UpstreamResultUnknownError)
      : undefined) ?? failures[0]
  )
}

async function collectFanOutResults<T>(
  requests: Promise<T>[],
  preserveUnknown = false,
): Promise<T[]> {
  if (!preserveUnknown) return Promise.all(requests)
  const settled = await Promise.allSettled(requests)
  const failure = fanOutFailure(settled, true)
  if (failure && settled.some((one) => one.status === 'fulfilled')) {
    throw new UpstreamResultUnknownError('部分请求已完成，整组结果和结算待核查。', {
      cause: failure.reason,
    })
  }
  if (failure) throw failure.reason
  return settled.flatMap((one) => (one.status === 'fulfilled' ? [one.value] : []))
}

/** Google 直连认自己的 key 头；其余上游都是 Bearer。 */
function upstreamAuthHeader(style: ChannelRouteStyle, key: string): Record<string, string> {
  if (!key) return {}
  return style === 'veo-videos' ? { 'x-goog-api-key': key } : { authorization: `Bearer ${key}` }
}

async function parseUpstreamResponse(res: UpstreamResponse): Promise<UpstreamCallResult> {
  const text = await res.text()
  let payload: unknown = text
  try {
    payload = JSON.parse(text)
  } catch {
    /* keep raw text */
  }
  if (!res.ok) {
    const message = extractErrorMessage(payload, res.status)
    // 上游 envelope 完整落 log（截断）：extractErrorMessage 可能把诊断信息提取
    // 成兜底字符串（如 "Upstream request failed"），原始 body 里的 error.code /
    // 上游真错因（"upstream did not return image output" 等）会丢，这里补回。
    log.warn(
      {
        event: 'upstream.non_2xx',
        upstreamStatus: res.status,
        message,
        payloadPreview: stringifyUpstreamPayload(payload),
      },
      'upstream returned non-2xx',
    )
    const err = new Error(message) as Error & { upstreamStatus: number; upstreamPayload: unknown }
    err.upstreamStatus = res.status
    err.upstreamPayload = payload
    throw err
  }
  return { payload }
}

export {
  extractUpstreamFailure,
  UpstreamPartialResultError,
  UpstreamResultUnknownError,
  UpstreamTimeoutError,
} from './upstream/errors'
export type { UpstreamCallResult } from './upstream/shared'
