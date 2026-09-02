import { Buffer, File } from 'node:buffer'
import { QUEUE_TIMEOUTS, type QueueProvider } from '@image-playground/shared'
import sharp from 'sharp'
import { Agent, FormData, fetch as undiciFetch } from 'undici'
import { config } from '../config'
import { getChannels } from './channels'
import type { HydratedSubmitRequest } from './imageArchive'
import { log } from './logger'
import { resolveApiKey } from './resolveApiKey'

/**
 * Convert queued requests into OpenAI Images or Gemini generateContent calls.
 *
 * The BFF does not translate model parameters. OpenAI requests use multipart edits when input
 * images are present and JSON generations otherwise. Gemini requests use generateContent.
 */

/**
 * 每 channel 的上游路由风格。命中映射的 channel 用 channels.json 自带的
 * baseUrl + auth.secret（单一事实源），不走 UPSTREAM_BASE_URL 通用网关；
 * value 决定 callUpstream 走哪套上游协议。
 *
 * 不能按 model 盲查 channels：网关部署用 UPSTREAM_BASE_URL 故意把
 * openai/gemini channel 指到同一中转上游，channels.json 里它们的 baseUrl
 * 只是名义官方地址，盲查会把网关部署静默切成直连。
 */
type ChannelRouteStyle =
  /**
   * Agnes 风格上游：没有 images/edits 端点，文生图与图生图共用
   * images/generations JSON，输入图放 extra_body.image。
   */
  | 'agnes-generations-json'
  /** 标准 OpenAI Images 语义：generations JSON / edits multipart / n>1 fan-out。 */
  | 'openai-images'
  /** Grok 只接受一张编辑输入图；多张参考图先合成带序号标签的 contact sheet。 */
  | 'grok-openai-images'

const CHANNEL_ROUTE_STYLES: Readonly<Record<string, ChannelRouteStyle | undefined>> = {
  'agnes-images': 'agnes-generations-json',
  'grok-images': 'grok-openai-images',
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
    }
  }
  const version = provider === 'gemini' ? 'v1beta' : 'v1'
  return {
    baseUrl: `${config.upstream.baseUrl}/${version}`,
    key: resolveApiKey(provider),
    style: 'openai-images',
    forceB64Json: false,
    // 通用网关没有 capability 声明，按老行为原样透传。
    supportsModeration: true,
    asyncTasks: provider === 'openai-compat' && config.upstream.asyncImageTasks,
  }
}
export interface UpstreamCallParams {
  provider: QueueProvider
  model: string
  request: HydratedSubmitRequest
  signal?: AbortSignal
  /** Runs immediately before each upstream invocation is dispatched. Polling does not count. */
  beforeRequest?: () => Promise<void>
  /** 异步提交拿到 id 后、开始轮询**之前**调用；必须在这一步之内把 id 持久化。 */
  onUpstreamTaskIds?: (taskIds: readonly string[]) => Promise<void>
  /** 本任务已提交过的上游异步任务：这些 id 只轮询，永不重提。 */
  resume?: UpstreamResume
}

export interface UpstreamResume {
  readonly taskIds: readonly string[]
  /** 首次提交时刻，超时预算的锚点；重启不能重新发一份完整预算。 */
  readonly submittedAt: number
}

export interface UpstreamCallResult {
  payload: unknown
}

interface UpstreamResponse {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}

type UpstreamFetch = (
  input: Parameters<typeof undiciFetch>[0],
  init?: Parameters<typeof undiciFetch>[1],
) => Promise<UpstreamResponse>
type UpstreamFetchInit = Parameters<UpstreamFetch>[1]

export const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000
export const UPSTREAM_TRANSPORT_TIMEOUT_MS = QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS + 60_000

const upstreamDispatcher = new Agent({
  connectTimeout: UPSTREAM_CONNECT_TIMEOUT_MS,
  headersTimeout: UPSTREAM_TRANSPORT_TIMEOUT_MS,
  bodyTimeout: UPSTREAM_TRANSPORT_TIMEOUT_MS,
})

let upstreamFetch: UpstreamFetch = undiciFetch

/** 测试注入点；undefined 恢复真实 Undici transport。 */
export function setUpstreamFetchForTesting(fetchImpl?: UpstreamFetch): void {
  upstreamFetch = fetchImpl ?? undiciFetch
}

/**
 * 自定义错误：BFF 自己的 UPSTREAM_HARD_TIMEOUT_MS 切的（vs 上游返 4xx/5xx
 * 或 socket 异常关）。task-runner 用 instanceof 检查并统一落库为
 * `upstream_result_unknown`，避免自动重试重复执行。
 */
export class UpstreamResultUnknownError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'UpstreamResultUnknownError'
  }
}

export class UpstreamTimeoutError extends UpstreamResultUnknownError {
  constructor(message = 'Upstream call exceeded BFF hard timeout') {
    super(message)
    this.name = 'UpstreamTimeoutError'
  }
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
  } = resolveUpstream(provider, model)
  let request = params.request
  // Grok 回的 imgen.x.ai URL 对服务器出口 IP 一律 403（带 Bearer 也 403），归档取不到图。
  if (forceB64Json) {
    request = { ...request, extra: { ...request.extra, response_format: 'b64_json' } }
  }
  if (!supportsModeration) request = withoutModeration(request)

  const abort = new AbortController()
  let timedOut = false
  const deadlineAt = (resume?.submittedAt ?? Date.now()) + QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS
  const timer = setTimeout(
    () => {
      timedOut = true
      abort.abort()
    },
    Math.max(0, deadlineAt - Date.now()),
  )
  const onExternalAbort = () => abort.abort()
  if (externalSignal?.aborted) abort.abort()
  else externalSignal?.addEventListener('abort', onExternalAbort)

  const fetchInit = (init: UpstreamFetchInit): UpstreamFetchInit => ({
    ...init,
    signal: abort.signal,
    dispatcher: upstreamDispatcher,
  })

  /**
   * `counted` 区分「一次上游调用」与「一次轮询」：只有前者过记账回调。异步模式下
   * 轮询次数与计费无关，混进去会让 upstream_invocation_count 失去意义。
   */
  const performFetch = async (
    url: string,
    init: UpstreamFetchInit,
    counted = true,
  ): Promise<UpstreamResponse> => {
    try {
      if (abort.signal.aborted) throw new DOMException('Upstream request aborted', 'AbortError')
      if (counted) await beforeRequest?.()

      // The accounting callback is the dispatch commit point. Start the transport with a fresh
      // signal before relaying cancellation so a cancellation that loses the database race cannot
      // create a charged task without a corresponding upstream invocation.
      const requestAbort = new AbortController()
      const relayAbort = () => requestAbort.abort()
      const responsePromise = upstreamFetch(url, {
        ...fetchInit(init),
        signal: requestAbort.signal,
      })
      abort.signal.addEventListener('abort', relayAbort, { once: true })
      if (abort.signal.aborted) relayAbort()
      try {
        return await responsePromise
      } finally {
        abort.signal.removeEventListener('abort', relayAbort)
      }
    } catch (err) {
      if (timedOut) throw new UpstreamTimeoutError()
      if (externalSignal?.aborted) throw err
      const detail = err instanceof Error ? err.message : String(err)
      throw new UpstreamResultUnknownError(`上游连接中断，执行结果未知：${detail}`, {
        cause: err,
      })
    }
  }

  const parseResponse = async (res: UpstreamResponse): Promise<UpstreamCallResult> => {
    try {
      return await parseUpstreamResponse(res)
    } catch (err) {
      if (timedOut) throw new UpstreamTimeoutError()
      if (externalSignal?.aborted) throw err
      if (typeof (err as { upstreamStatus?: unknown })?.upstreamStatus === 'number') throw err
      const detail = err instanceof Error ? err.message : String(err)
      throw new UpstreamResultUnknownError(`上游响应中断，执行结果未知：${detail}`, {
        cause: err,
      })
    }
  }

  // 这个 try 里每个 return 都必须 `return await`：裸 return 一个 promise 会让下面的
  // finally 立刻跑，在请求还在飞的时候摘掉 external abort 监听并清掉超时定时器 ——
  // 取消与硬超时都会静默失效。
  try {
    if (provider === 'openai-compat') {
      const authHeader: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {}
      const resumeIds = resume?.taskIds ?? []
      const useAsyncTasks = asyncTasks || resumeIds.length > 0

      /**
       * 补齐到 count 个上游任务：已有 id 原样带出，只为缺口发提交请求。上游没有幂等键，
       * 重提已落库的 id 就是第二次计费，所以缺口是唯一可以提交的份额。
       */
      const collectTaskIds = async (
        url: string,
        count: number,
        makeInit: () => UpstreamFetchInit,
      ): Promise<string[]> => {
        const missing = count - resumeIds.length
        if (missing <= 0) return [...resumeIds]
        const settled = await Promise.allSettled(
          Array.from({ length: missing }, async () =>
            extractAsyncTaskId((await parseResponse(await performFetch(url, makeInit()))).payload),
          ),
        )
        const taskIds = [
          ...resumeIds,
          ...settled.flatMap((one) => (one.status === 'fulfilled' ? [one.value] : [])),
        ]
        // 先落库再抛：部分失败时成功那几个已经计费，丢了 id 就没人收。
        if (taskIds.length > resumeIds.length) await onUpstreamTaskIds?.(taskIds)
        const failure = settled.find((one) => one.status === 'rejected')
        if (failure) {
          warnIfAsyncTasksDisabled(failure.reason)
          throw failure.reason
        }
        return taskIds
      }

      /** 硬超时会 abort 掉轮询的 sleep；不映射的话裸 AbortError 会被当成用户取消，行没有终态。 */
      const pollDelay = async (attempt: number): Promise<void> => {
        try {
          await abortableSleep(asyncPollDelayMs(attempt), abort.signal)
        } catch (err) {
          if (timedOut) throw new UpstreamTimeoutError()
          throw err
        }
      }

      /** 轮询单个上游任务到终态。判定与提交侧方向相反：瞬时错误一律继续轮。 */
      const pollAsyncTask = async (taskId: string): Promise<UpstreamCallResult> => {
        const pollUrl = `${base}/images/tasks/${encodeURIComponent(taskId)}`
        for (let attempt = 0; ; attempt++) {
          if (Date.now() >= deadlineAt) throw new UpstreamTimeoutError()
          let payload: unknown
          try {
            payload = (
              await parseResponse(
                await performFetch(pollUrl, { method: 'GET', headers: authHeader }, false),
              )
            ).payload
          } catch (err) {
            if (timedOut || externalSignal?.aborted || !isRecoverablePollFailure(err)) throw err
            // 留 payload 为 undefined，下面按 pending 走同一条退避路径。
          }
          const state = readAsyncTaskState(payload)
          if (state.kind === 'completed') return { payload: state.payload }
          if (state.kind === 'failed') throw asyncTaskFailure(state.status, payload)
          await pollDelay(attempt)
        }
      }

      /**
       * 一次逻辑调用 → count 个上游请求 → 合并。同步模式直接发；异步模式提交后转轮询。
       * n 策略两个端点共用：n===1 直接透传，n>1 fan-out 成 count 次单图请求（每次不带 n）
       * 再合并 data，对 task-runner / 前端透明。
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
          )
        }
        const taskIds = await collectTaskIds(`${url}/async`, count, makeInit)
        const results = await Promise.all(taskIds.map(pollAsyncTask))
        return results.length === 1 ? results[0]! : merge(results)
      }

      // Agnes 风格上游：没有 images/edits 端点，图生图与文生图
      // 共用 images/generations JSON，输入图放 extra_body.image（data URI / URL）。
      // 实测注意：文档"Important Notes"声称的 top-level image 数组会被上游**静默忽略**
      // （跑成纯文生图），必须放 extra_body；n 同样被忽略，这里学 gemini 分支 fan-out。
      if (style === 'agnes-generations-json') {
        if (request.mask) {
          // 挂 upstreamStatus=400 → retry.ts 判为永久失败，不浪费 3 次重试
          const err = new Error(
            '该模型不支持遮罩编辑（上游无 mask 能力），请换 GPT 模型或去掉遮罩',
          ) as Error & { upstreamStatus: number }
          err.upstreamStatus = 400
          throw err
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
        // Grok edits 的多张参考图先合成 contact sheet，确保发给上游的 image 始终只有一张。
        const editRequest =
          style === 'grok-openai-images'
            ? await normalizeGrokEditInputs(request, abort.signal)
            : request
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
      const body = JSON.stringify(
        buildOpenAIBody(model, n === 1 ? request : withoutImageCount(request)),
      )
      return await dispatch(
        `${base}/images/generations`,
        n,
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
      )
    }
    throw new Error(`Unsupported provider: ${provider satisfies never}`)
  } catch (err) {
    // fan-out 请求任一失败时取消其它同批请求，避免 callUpstream 已返回失败后仍在后台跑。
    abort.abort()
    throw err
  } finally {
    clearTimeout(timer)
    externalSignal?.removeEventListener('abort', onExternalAbort)
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

/**
 * 轮询专用的可恢复判定，**与 retry.ts 的提交侧判定方向相反**，不要合并：提交没有幂等键，
 * 重来一次就是重复计费；轮询只是再读一次同一个任务，代价为零。
 */
function isRecoverablePollFailure(err: unknown): boolean {
  const { status } = extractUpstreamFailure(err)
  if (status === null) return err instanceof UpstreamResultUnknownError
  return status === 408 || status === 429 || status >= 500
}

function extractAsyncTaskId(payload: unknown): string {
  const taskId = (payload as { task_id?: unknown } | null)?.task_id
  if (typeof taskId === 'string' && taskId.length > 0) return taskId
  // 任务可能已经建起来在烧钱，但我们拿不到 id 去轮询它 —— 按结果未知处理，绝不自动重提。
  throw new UpstreamResultUnknownError('上游异步任务提交未返回 task_id，执行结果未知')
}

/** 上游把异步开关关掉时提交一律 404。单独一条 event，别混在通用 upstream 失败里。 */
function warnIfAsyncTasksDisabled(err: unknown): void {
  const { status, body } = extractUpstreamFailure(err)
  if (status !== 404 || !body?.includes('async image tasks are not enabled')) return
  log.error(
    { event: 'upstream.async_disabled', upstreamStatus: status },
    'upstream async image tasks are disabled; turn off the asyncTasks declaration on our side',
  )
}

type AsyncTaskState =
  | { kind: 'pending' }
  | { kind: 'completed'; payload: unknown }
  | { kind: 'failed'; status: number | null }

/** 未知 status 一律当 pending 继续轮：上游加新中间态时不该把任务判死。 */
function readAsyncTaskState(payload: unknown): AsyncTaskState {
  if (!payload || typeof payload !== 'object') return { kind: 'pending' }
  const body = payload as { status?: unknown; result?: unknown; http_status?: unknown }
  if (body.status === 'completed') {
    // 结果在 result 里；上游也可能直接把 OpenAI envelope 平铺在根级。
    const result = body.result
    return { kind: 'completed', payload: result && typeof result === 'object' ? result : payload }
  }
  if (body.status !== 'failed') return { kind: 'pending' }
  return { kind: 'failed', status: typeof body.http_status === 'number' ? body.http_status : null }
}

/** 上游任务终态失败 → 复用 HTTP 失败的错误形状，retry.ts 与 admin 才认得出来。 */
function asyncTaskFailure(status: number | null, payload: unknown): Error {
  const err = new Error(extractErrorMessage(payload, status ?? 502)) as Error & {
    upstreamStatus?: number
    upstreamPayload: unknown
  }
  if (status !== null) err.upstreamStatus = status
  err.upstreamPayload = payload
  return err
}

async function fanOutRequests(
  requestedCount: number | undefined,
  run: () => Promise<UpstreamCallResult>,
  merge: (results: UpstreamCallResult[]) => UpstreamCallResult,
): Promise<UpstreamCallResult> {
  const count = Math.max(1, requestedCount ?? 1)
  if (count === 1) return run()
  return merge(await Promise.all(Array.from({ length: count }, run)))
}

function mergeGeminiCandidateResults(results: UpstreamCallResult[]): UpstreamCallResult {
  return {
    payload: {
      candidates: results.flatMap((result) => {
        const payload = result.payload as { candidates?: unknown[] } | null
        return Array.isArray(payload?.candidates) ? payload.candidates : []
      }),
    },
  }
}

function mergeOpenAIDataResults(results: UpstreamCallResult[]): UpstreamCallResult {
  const first = results[0]?.payload
  const firstPayload =
    first && typeof first === 'object' && !Array.isArray(first)
      ? (first as Record<string, unknown>)
      : {}
  return {
    payload: {
      ...firstPayload,
      data: results.flatMap((result) => {
        const payload = result.payload as { data?: unknown[] } | null
        return Array.isArray(payload?.data) ? payload.data : []
      }),
    },
  }
}

/** fan-out 的单次请求体用：去掉 n，让上游按默认的一张返回。 */
function withoutImageCount(request: HydratedSubmitRequest): HydratedSubmitRequest {
  const { n: _n, ...singleRequest } = request
  return singleRequest
}

/**
 * Grok 网关对请求体里的 moderation 一律 403 `Request blocked by upstream content policy`，
 * 与内容是否违规无关。前端 chip 隐藏后 params.moderation 仍保留默认值并照发，
 * 这里是唯一的拦截点。extra 也要清：它最后 spread 进 body，绕过顶层字段。
 */
function withoutModeration(request: HydratedSubmitRequest): HydratedSubmitRequest {
  const { moderation: _moderation, ...rest } = request
  if (!rest.extra || !('moderation' in rest.extra)) return rest
  const { moderation: _fromExtra, ...extra } = rest.extra
  return { ...rest, extra }
}

/**
 * 把 fan-out 的多次单图响应合并成一个 OpenAI 风格 payload。
 * 只保留 data；单次响应的顶层字段（created / usage / size / quality / output_format）丢弃，
 * 即 fan-out 结果没有 extractImages 的 actual_params。
 */
function mergeOpenAIImageResults(results: readonly UpstreamCallResult[]): UpstreamCallResult {
  return {
    payload: {
      data: results.flatMap((result) => {
        const payload = result.payload as { data?: unknown[] } | null
        return Array.isArray(payload?.data) ? payload.data : []
      }),
    },
  }
}

/**
 * Agnes 风格（agnes-generations-json）请求体：文生图与图生图同一端点同一 JSON 体，
 * 输入图放 extra_body.image（实测 top-level image 会被上游静默忽略）。
 * quality / n 上游不识别 → 不传（n 由 callUpstream fan-out 实现）。
 * 新增的 OpenAI / Gemini 参数也不传，避免上游拒绝或静默忽略未知字段。
 */
function buildAgnesGenerationsBody(
  model: string,
  request: HydratedSubmitRequest,
): Record<string, unknown> {
  const { extra_body: extraBody, ...extraTop } = (request.extra ?? {}) as {
    extra_body?: Record<string, unknown>
    [k: string]: unknown
  }
  const mergedExtraBody: Record<string, unknown> = { ...(extraBody ?? {}) }
  if (request.input_images?.length) mergedExtraBody.image = request.input_images
  return {
    model,
    prompt: request.prompt,
    ...(request.size ? { size: request.size } : {}),
    ...extraTop,
    ...(Object.keys(mergedExtraBody).length ? { extra_body: mergedExtraBody } : {}),
  }
}

function buildOpenAIBody(model: string, request: HydratedSubmitRequest): Record<string, unknown> {
  return {
    model,
    prompt: request.prompt,
    ...(request.size ? { size: request.size } : {}),
    ...(request.quality ? { quality: request.quality } : {}),
    ...(request.output_format ? { output_format: request.output_format } : {}),
    ...(request.moderation ? { moderation: request.moderation } : {}),
    ...(request.output_compression != null
      ? { output_compression: request.output_compression }
      : {}),
    ...(request.n ? { n: request.n } : {}),
    ...(request.extra ?? {}),
  }
}

function buildGrokEditBody(model: string, request: HydratedSubmitRequest): Record<string, unknown> {
  // n 由上层 fan-out 承担；extra 最后 spread 进 body，所以 extra.n 也要一起剥。
  const { n: _n, ...body } = buildOpenAIBody(model, request)
  const image = request.input_images?.[0]
  return {
    ...body,
    ...(image ? { image: { type: 'image_url', url: image } } : {}),
    ...(request.mask ? { mask: { type: 'image_url', url: request.mask } } : {}),
  }
}

const GROK_CONTACT_SHEET_MAX_SIDE = 2048
const GROK_CONTACT_SHEET_MAX_INPUTS = 16
const GROK_CONTACT_SHEET_GAP = 16
const GROK_CONTACT_SHEET_LABEL_HEIGHT = 64

/**
 * Grok edits only accept one image. Combine multiple inputs into a numbered contact sheet.
 */
async function normalizeGrokEditInputs(
  request: HydratedSubmitRequest,
  signal: AbortSignal,
): Promise<HydratedSubmitRequest> {
  signal.throwIfAborted()
  const inputImages = request.input_images ?? []
  if (inputImages.length > GROK_CONTACT_SHEET_MAX_INPUTS) {
    throw new Error(
      `Grok contact sheet 最多支持 ${GROK_CONTACT_SHEET_MAX_INPUTS} 张参考图，当前收到 ${inputImages.length} 张`,
    )
  }
  if (inputImages.length > 1 && request.mask) {
    throw new Error(
      'Grok 编辑不支持“多张参考图 + 遮罩”：原始遮罩坐标无法映射到 contact sheet，请只保留一张参考图或移除遮罩',
    )
  }
  if (inputImages.length <= 1) return request

  const columns = Math.ceil(Math.sqrt(inputImages.length))
  const rows = Math.ceil(inputImages.length / columns)
  const gap = Math.min(
    GROK_CONTACT_SHEET_GAP,
    Math.floor(GROK_CONTACT_SHEET_MAX_SIDE / (Math.max(columns, rows) * 8)),
  )
  const cellWidth = Math.max(
    1,
    Math.floor((GROK_CONTACT_SHEET_MAX_SIDE - gap * (columns - 1)) / columns),
  )
  const rowHeight = Math.max(2, Math.floor((GROK_CONTACT_SHEET_MAX_SIDE - gap * (rows - 1)) / rows))
  const labelHeight = Math.min(
    GROK_CONTACT_SHEET_LABEL_HEIGHT,
    Math.max(1, Math.floor(rowHeight / 5)),
  )
  const imageSide = Math.max(1, Math.min(cellWidth, rowHeight - labelHeight))
  const sheetWidth = columns * imageSide + gap * (columns - 1)
  const sheetHeight = rows * (imageSide + labelHeight) + gap * (rows - 1)

  const tiles: Array<{ image: Buffer; label: Buffer }> = []
  for (const [index, dataUrl] of inputImages.entries()) {
    const { bytes } = decodeDataUrl(dataUrl)
    signal.throwIfAborted()
    const image = await sharp(bytes)
      .rotate()
      .resize(imageSide, imageSide, {
        fit: 'contain',
        background: { r: 245, g: 245, b: 245, alpha: 1 },
      })
      .png()
      .toBuffer()
    signal.throwIfAborted()
    tiles.push({ image, label: buildTileLabelSvg(index, imageSide, labelHeight) })
  }

  const overlays = tiles.flatMap(({ image, label }, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    const left = column * (imageSide + gap)
    const top = row * (imageSide + labelHeight + gap)
    return [
      { input: image, left, top },
      { input: label, left, top: top + imageSide },
    ]
  })
  signal.throwIfAborted()
  const sheet = await sharp({
    create: {
      width: sheetWidth,
      height: sheetHeight,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite(overlays)
    .png()
    .toBuffer()
  signal.throwIfAborted()

  return {
    ...request,
    input_images: [`data:image/png;base64,${sheet.toString('base64')}`],
  }
}

function buildTileLabelSvg(index: number, width: number, height: number): Buffer {
  const fontSize = Math.max(12, Math.min(28, Math.floor(height * 0.44)))
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
      '<rect width="100%" height="100%" fill="#111827"/>' +
      '<text x="24" y="50%" dy="0.35em" fill="#ffffff" font-family="sans-serif" ' +
      `font-size="${fontSize}" font-weight="700">Image ${index + 1}</text>` +
      '</svg>',
  )
}

interface OpenAIEditFiles {
  inputs: File[]
  mask?: File
}

function prepareOpenAIEditFiles(request: HydratedSubmitRequest): OpenAIEditFiles {
  return {
    inputs: (request.input_images ?? []).map((dataUrl) => dataUrlToFile(dataUrl, 'image.png')),
    ...(request.mask ? { mask: dataUrlToFile(request.mask, 'mask.png') } : {}),
  }
}

function buildOpenAIEditFormData(model: string, request: HydratedSubmitRequest): FormData {
  const files = prepareOpenAIEditFiles(request)
  const form = new FormData()
  form.append('model', model)
  form.append('prompt', request.prompt)
  if (request.size) form.append('size', request.size)
  if (request.quality) form.append('quality', request.quality)
  if (request.output_format) form.append('output_format', request.output_format)
  if (request.moderation) form.append('moderation', request.moderation)
  if (request.output_compression != null) {
    form.append('output_compression', String(request.output_compression))
  }
  for (const input of files.inputs) form.append('image[]', input)
  if (files.mask) form.append('mask', files.mask)
  // edits 不接受 n；数量由本地 fan-out 实现。其余 extra 标量字段原样透传。
  for (const [k, v] of Object.entries(request.extra ?? {})) {
    if (k === 'n' || v == null) continue
    form.append(k, typeof v === 'string' ? v : JSON.stringify(v))
  }
  return form
}

function dataUrlToFile(dataUrl: string, filename: string): File {
  const { mime, bytes } = decodeDataUrl(dataUrl)
  return new File([Buffer.from(bytes)], filename, { type: mime })
}

function decodeDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } {
  const m = dataUrl.match(/^data:([^;,]+);base64,(.*)$/i)
  if (!m) throw new Error('input_images 中的数据 URL 格式无效，必须是 data:<mime>;base64,<...>')
  const mime = m[1]!
  const bin = atob(m[2]!)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return { mime, bytes }
}

function buildGeminiBody(request: HydratedSubmitRequest): Record<string, unknown> {
  const parts: Array<Record<string, unknown>> = [{ text: request.prompt }]
  for (const dataUrl of request.input_images ?? []) {
    const m = dataUrl.match(/^data:([^;,]+);base64,(.*)$/i)
    if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } })
  }

  const { generationConfig: extraGenerationConfig, ...extraTopLevel } = (request.extra ?? {}) as {
    generationConfig?: Record<string, unknown>
    [key: string]: unknown
  }
  const generationConfig: Record<string, unknown> = { responseModalities: ['IMAGE'] }
  if (request.aspect_ratio || request.image_size) {
    generationConfig.imageConfig = {
      ...(request.aspect_ratio ? { aspectRatio: request.aspect_ratio } : {}),
      ...(request.image_size ? { imageSize: request.image_size } : {}),
    }
  }
  if (request.thinking_level) {
    generationConfig.thinkingConfig = { thinkingLevel: request.thinking_level }
  }

  return {
    contents: [{ role: 'user', parts }],
    // extra.generationConfig 放最后：调用方显式给的配置压过这里从扁平参数推导的默认值。
    generationConfig: { ...generationConfig, ...extraGenerationConfig },
    ...extraTopLevel,
  }
}

/**
 * 非 2xx 时上游响应体的截断上限，避免上游回 base64 巨长串吞内存。log preview 与
 * 落库的 tasks.upstream_body 共用同一上限，两处看到的内容一致。
 */
const UPSTREAM_ERROR_BODY_MAX_CHARS = 2000

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

/** 上游错误响应体转可存储字符串（截断）。空体返回 null，避免落库一个空串。 */
function stringifyUpstreamPayload(payload: unknown): string | null {
  if (payload === null || payload === undefined) return null
  const text = typeof payload === 'object' ? JSON.stringify(payload) : String(payload)
  if (!text) return null
  return text.slice(0, UPSTREAM_ERROR_BODY_MAX_CHARS)
}

/**
 * 从 catch 到的错误里抽上游 HTTP 层诊断信息，供 task-runner 落库、admin 直接展示。
 * transport 中断 / BFF 硬超时压根没拿到 HTTP 响应，两个字段都是 null——此时
 * error_type='upstream_result_unknown' 已经表达了「结果未知」。
 */
export function extractUpstreamFailure(err: unknown): {
  status: number | null
  body: string | null
} {
  // 用 in / typeof 运行时窄化，不做 `err as { upstreamStatus?: unknown }` 这种
  // 断言式访问：err 来自 catch，形状没有任何保证，断言只会把错读伪装成合法读。
  if (!err || typeof err !== 'object' || !('upstreamStatus' in err)) {
    return { status: null, body: null }
  }
  const status = err.upstreamStatus
  if (typeof status !== 'number') return { status: null, body: null }
  const body = 'upstreamPayload' in err ? stringifyUpstreamPayload(err.upstreamPayload) : null
  return { status, body }
}

function extractErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    const errObj = obj.error as { message?: string } | string | undefined
    if (typeof errObj === 'object' && typeof errObj?.message === 'string') return errObj.message
    if (typeof errObj === 'string') return errObj
    if (typeof obj.message === 'string') return obj.message
    if (typeof obj.detail === 'string') return obj.detail
  }
  if (typeof payload === 'string' && payload.trim()) {
    return payload.length > 500 ? `${payload.slice(0, 500)}…` : payload
  }
  return `Upstream HTTP ${status}`
}
