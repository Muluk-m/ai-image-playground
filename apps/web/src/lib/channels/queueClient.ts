import {
  QUEUE_TIMEOUTS,
  type QueueProvider,
  type ResultImageMeta,
  type ResultResponse,
  type StatusResponse,
  type StatusResultMeta,
  type SubmitResponse,
  type TaskErrorType,
  type VideoRequest,
} from '@image-playground/shared'
import { describeError, i18next } from '../../i18n'
import type { TaskParams } from '../../types'
import { normalizeApiTimeout } from '../apiProfiles'
import { authenticatedBffFetch } from '../authClient'
import { getDeviceId } from '../deviceId'
import {
  assertImageInputPayloadSize,
  bytesToDataUrl,
  type CallApiOptions,
  type CallApiResult,
  getApiErrorMessage,
  getDataUrlEncodedByteSize,
} from '../imageApiShared'
import { bffBaseUrl } from '../runtimeConfig'
import { nearestAspectRatio } from '../size'
import { taskFailure } from '../taskError'
import type { BuiltinEdgeProfile, ProviderKind, PublicChannel } from './types'

/**
 * BFF 400 响应里 `message` 是中文的，直接显示就会把中文漏给英文用户。`error` 码是稳定的，
 * 按码取译文。这里只收会带中文 message 的那几个；其余码（配额、鉴权等）各有自己的分支。
 */
const BFF_SUBMIT_ERROR_KEYS = {
  video_not_supported: 'queue.bffVideoNotSupported',
  video_params_required: 'queue.bffVideoParamsRequired',
  invalid_video_request: 'queue.bffInvalidVideoRequest',
  invalid_video_source: 'queue.bffInvalidVideoSource',
  invalid_input_image: 'queue.bffInvalidInputImage',
} as const

const { POLL_BACKOFF_MS, POLL_MAX_MS, POLL_MAX_CONSECUTIVE_FAILURES } = QUEUE_TIMEOUTS

/** 队列产出的字节地址。留在传输层，避免认证启动时提前加载用户 store。 */
export function queueOutputUrl(taskId: string, outputIndex: number): string {
  return `${bffBaseUrl()}/v1/queue/requests/${taskId}/output/${outputIndex}`
}

/**
 * Queue 模式：submit → polling → fetch metadata → fetch each image binary。
 *
 * 浏览器 ↔ BFF 全是 < 1s 短请求；BFF 用 localhost 调上游，任务多久都不受
 * 浏览器/Edge 长超时限制。
 */

export async function callQueueChannelApi(
  opts: CallApiOptions,
  profile: BuiltinEdgeProfile,
  channel: PublicChannel,
): Promise<CallApiResult> {
  const provider = toQueueProvider(channel.kind)
  if (!provider) {
    throw new Error(i18next.t('queue.unsupportedKindCall', { ns: 'lib', kind: channel.kind }))
  }
  assertImageInputPayloadSize(
    opts.inputImageDataUrls.reduce((sum, url) => sum + getDataUrlEncodedByteSize(url), 0),
  )

  const model = profile.selectedModelId
  const base = bffBaseUrl()
  const codexCli = Boolean(channel.defaults.codexCli)

  const requestId = await submit(base, provider, model, opts, codexCli, opts.clientRequestId)
  opts.onQueueSubmitted?.(requestId)
  return await pollAndFetch(channel, base, requestId, opts.onQueueStatus)
}

/**
 * 刷新页面恢复路径：跳过 submit，用持久化的 requestId 直接 poll+fetch。
 */
export async function resumeQueueChannelApi(
  opts: CallApiOptions,
  _profile: BuiltinEdgeProfile,
  channel: PublicChannel,
  requestId: string,
): Promise<CallApiResult> {
  // 校验 kind 合法但 resume 本身只用 channel + requestId — provider/opts/profile
  // 仅为跟 callQueueChannelApi 保持调用签名一致，恢复路径不需要重新构造请求。
  if (!toQueueProvider(channel.kind)) {
    throw new Error(i18next.t('queue.unsupportedKindResume', { ns: 'lib', kind: channel.kind }))
  }
  return await pollAndFetch(channel, bffBaseUrl(), requestId, opts.onQueueStatus)
}

async function pollAndFetch(
  channel: PublicChannel,
  base: string,
  requestId: string,
  onStatus?: CallApiOptions['onQueueStatus'],
): Promise<CallApiResult> {
  // poll 拿到 completed 时 status response 已经内联了 meta（BFF 新协议）；缺失时
  // 才回退到 GET /result。少一次 RTT 是常态路径，fallback 走旧 BFF 版本。
  const inlined = await poll(base, requestId, onStatus)
  const meta = inlined ?? (await fetchResultMeta(base, requestId))
  if (!meta.images?.length) {
    throw new Error(i18next.t('queue.completedWithoutImages', { ns: 'lib' }))
  }

  // 并发拉所有图片二进制，转 data URL 给上游既有存储路径用。
  // 单图慢的话仍是用户下行瓶颈，但绕开了 base64 33% 膨胀 + JSON 双重开销。
  const downloadController = new AbortController()
  const timer = setTimeout(
    () => downloadController.abort(),
    normalizeApiTimeout(channel.defaults.timeout) * 1000,
  )
  try {
    const images = await Promise.all(
      meta.images.map((m) =>
        fetchImageDataUrl(base, requestId, m.index, m.mime, downloadController.signal),
      ),
    )
    const revisedPrompts = meta.images.map((m) => m.revised_prompt)
    const actualParams = narrowActualParams(meta.actual_params)
    return {
      images,
      revisedPrompts,
      actualParams,
      actualParamsList: meta.images.map(() => actualParams),
      ...(meta.raw_image_urls?.length ? { rawImageUrls: meta.raw_image_urls } : {}),
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 把 channel.kind 归一化到 BFF queue 协议的 provider 维度。 */
export function toQueueProvider(kind: ProviderKind): QueueProvider | null {
  if (kind === 'openai-compat' || kind === 'openai-queue') return 'openai-compat'
  if (kind === 'gemini' || kind === 'gemini-queue') return 'gemini'
  return null
}

async function submit(
  base: string,
  provider: QueueProvider,
  model: string,
  opts: CallApiOptions,
  codexCli: boolean,
  clientRequestId: string | undefined,
): Promise<string> {
  // codex CLI 模式：quality 字段丢弃（codex 网关会拒绝）。防改写 guard 前缀已在
  // callImageApi 分发层统一应用，这里拿到的 prompt 是最终值；BFF 透传到上游。
  const body: Record<string, unknown> = {
    prompt: opts.prompt,
    device_id: getDeviceId(),
  }
  if (opts.params.size && opts.params.size !== 'auto') body.size = opts.params.size
  if (!codexCli && opts.params.quality && opts.params.quality !== 'auto')
    body.quality = opts.params.quality

  // 这两支必须逐字对齐 BYOK adapter（openaiCompatibleImageApi / geminiImageApi），
  // 否则同一组 chip 在自带 key 和队列两条路径下发出去的参数会不一致。
  if (provider === 'openai-compat') {
    body.output_format = opts.params.output_format
    body.moderation = opts.params.moderation
    if (opts.params.output_format !== 'png' && opts.params.output_compression != null) {
      body.output_compression = opts.params.output_compression
    }
  } else if (provider === 'gemini') {
    const aspectRatio = opts.params.gemini_aspect_ratio ?? nearestAspectRatio(opts.params.size)
    if (aspectRatio) body.aspect_ratio = aspectRatio
    if (opts.params.gemini_image_size) body.image_size = opts.params.gemini_image_size
    if (opts.params.gemini_thinking_level) body.thinking_level = opts.params.gemini_thinking_level
  }
  if (opts.params.n && opts.params.n > 1) body.n = opts.params.n
  if (opts.inputImageDataUrls.length) body.input_images = opts.inputImageDataUrls
  if (opts.maskDataUrl) body.mask = opts.maskDataUrl
  if (clientRequestId) body.client_request_id = clientRequestId

  return await postSubmit(base, provider, model, body)
}

/** submit 的 POST 与错误归一化。视频提交与图片提交共用，402 / 429 语义必须一致。 */
async function postSubmit(
  base: string,
  provider: QueueProvider,
  model: string,
  body: Record<string, unknown>,
): Promise<string> {
  const url = `${base}/v1/queue/${provider}/${encodeURIComponent(model)}/submit`
  const res = await authenticatedBffFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status === 402) {
    const json = (await res.json().catch(() => null)) as {
      error?: string
      required?: number
      available?: number
    } | null
    if (json?.error === 'insufficient_credits') {
      const err = new Error(i18next.t('queue.insufficientCredits', { ns: 'lib' })) as Error & {
        insufficientCredits: true
        required?: number
        available?: number
      }
      err.insufficientCredits = true
      if (typeof json.required === 'number') err.required = json.required
      if (typeof json.available === 'number') err.available = json.available
      throw err
    }
  }
  if (!res.ok) {
    // BFF 的 400 里 message 是中文的（`该模型不支持视频生成` 之类），它会直接显示给用户。
    // 前端按稳定的 error 码取译文，认不出来的码才退回服务端原文。克隆一份读，
    // 别把下面 429 分支和 getApiErrorMessage 要用的 body 吃掉。
    const coded = res.clone()
    if (res.status === 429) {
      const json = (await res.json().catch(() => null)) as {
        error?: string
        reset_at?: string
        quota?: number
      } | null
      if (json?.error === 'daily_quota_exceeded') {
        const exhausted =
          typeof json.quota === 'number' && Number.isSafeInteger(json.quota) && json.quota >= 0
            ? i18next.t('queue.dailyQuotaUsed', { ns: 'lib', quota: json.quota })
            : i18next.t('queue.dailyQuotaExhausted', { ns: 'lib' })
        const err = new Error(
          i18next.t('queue.quotaResetHint', { ns: 'lib', exhausted }),
        ) as Error & {
          quotaExceeded: boolean
          resetAt?: string
        }
        err.quotaExceeded = true
        if (json.reset_at) err.resetAt = json.reset_at
        throw err
      }
    }
    const code = ((await coded.json().catch(() => null)) as { error?: string } | null)?.error
    // `as const` 不能省：退化成 `string` 就过不了 t() 的字面量 key 检查，
    // 拼错的 key 也就不会在 typecheck 红了。
    const localized =
      code && code in BFF_SUBMIT_ERROR_KEYS
        ? BFF_SUBMIT_ERROR_KEYS[code as keyof typeof BFF_SUBMIT_ERROR_KEYS]
        : undefined
    const reason = localized ? i18next.t(localized, { ns: 'lib' }) : await getApiErrorMessage(res)
    throw new Error(i18next.t('queue.submitFailed', { ns: 'lib', reason }))
  }
  const json = (await res.json()) as SubmitResponse
  if (!json.request_id) throw new Error(i18next.t('queue.submitMissingRequestId', { ns: 'lib' }))
  return json.request_id
}

export interface VideoSubmitInput {
  channel: PublicChannel
  model: string
  prompt: string
  video: VideoRequest
  /** 首帧在 index 0、尾帧在 index 1；video 里的下标指向这个数组。 */
  inputImageDataUrls: string[]
  clientRequestId: string
}

export async function submitVideoRequest(input: VideoSubmitInput): Promise<string> {
  const provider = toQueueProvider(input.channel.kind)
  if (!provider) {
    throw new Error(
      i18next.t('queue.unsupportedKindVideo', { ns: 'lib', kind: input.channel.kind }),
    )
  }
  assertImageInputPayloadSize(
    input.inputImageDataUrls.reduce((sum, url) => sum + getDataUrlEncodedByteSize(url), 0),
  )
  const body: Record<string, unknown> = {
    prompt: input.prompt,
    device_id: getDeviceId(),
    video: input.video,
    client_request_id: input.clientRequestId,
  }
  if (input.inputImageDataUrls.length) body.input_images = input.inputImageDataUrls
  return await postSubmit(bffBaseUrl(), provider, input.model, body)
}

/**
 * 只等到 completed 并交出输出元信息。视频字节不落 IndexedDB —— 播放由 <video>
 * 直接打 BFF 输出端点，这里拉一遍只会把 mp4 读进内存又丢掉。
 */
export async function awaitQueueOutputs(requestId: string): Promise<ResultImageMeta[]> {
  const base = bffBaseUrl()
  const inlined = await poll(base, requestId)
  const meta = inlined ?? (await fetchResultMeta(base, requestId))
  if (!meta.images?.length) {
    throw new Error(i18next.t('queue.completedWithoutOutputs', { ns: 'lib' }))
  }
  return meta.images
}

type PollOutcome =
  | { kind: 'done'; result: StatusResultMeta | undefined }
  | { kind: 'failed'; message: string; errorType?: TaskErrorType }
  | { kind: 'cancelled' }
  | { kind: 'pending'; phase?: StatusResponse['phase'] }
  /** 短暂错误（5xx / 网络抖动），按 consecutiveFailures 计数 */
  | { kind: 'transient'; error: unknown }
  /** 确定性错误（4xx），立即放弃 */
  | { kind: 'fatal'; message: string }

async function classifyPollResponse(url: string): Promise<PollOutcome> {
  let res: Response
  try {
    res = await authenticatedBffFetch(url)
  } catch (err) {
    return { kind: 'transient', error: err }
  }
  if (!res.ok) {
    if (res.status >= 500)
      return { kind: 'transient', error: new Error(`BFF status ${res.status}`) }
    return { kind: 'fatal', message: await getApiErrorMessage(res) }
  }
  const json = (await res.json()) as StatusResponse
  if (json.status === 'completed') return { kind: 'done', result: json.result }
  if (json.status === 'failed')
    return {
      kind: 'failed',
      message: json.error?.message ?? i18next.t('queue.taskFailed', { ns: 'lib' }),
      // 分类跟着失败一起带走：界面按它出文案，服务端那句英文只留给「复制完整错误」。
      ...(json.error?.type ? { errorType: json.error.type } : {}),
    }
  if (json.status === 'cancelled') return { kind: 'cancelled' }
  return { kind: 'pending', phase: json.phase }
}

/**
 * 返回 completed 时附带的 result meta（新 BFF 内联），缺失则回 undefined 让调用方
 * 回退 GET /result。
 */
async function poll(
  base: string,
  requestId: string,
  onStatus?: CallApiOptions['onQueueStatus'],
): Promise<StatusResultMeta | undefined> {
  const url = `${base}/v1/queue/requests/${requestId}/status`
  const deadline = Date.now() + POLL_MAX_MS
  let consecutiveFailures = 0
  let lastTransientError: unknown = null

  for (let attempt = 0; Date.now() < deadline; attempt++) {
    await sleep(POLL_BACKOFF_MS[Math.min(attempt, POLL_BACKOFF_MS.length - 1)]!)
    const outcome = await classifyPollResponse(url)

    switch (outcome.kind) {
      case 'done':
        return outcome.result
      case 'failed':
        throw taskFailure(outcome.message, outcome.errorType)
      case 'cancelled':
        throw new Error(i18next.t('queue.cancelled', { ns: 'lib' }))
      case 'fatal':
        throw new Error(i18next.t('queue.statusFailed', { ns: 'lib', reason: outcome.message }))
      case 'transient': {
        consecutiveFailures++
        lastTransientError = outcome.error
        if (consecutiveFailures >= POLL_MAX_CONSECUTIVE_FAILURES) {
          const msg = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
          throw new Error(
            i18next.t('queue.consecutiveFailures', {
              ns: 'lib',
              attempts: POLL_MAX_CONSECUTIVE_FAILURES,
              reason: msg,
            }),
          )
        }
        break
      }
      case 'pending':
        if (outcome.phase) onStatus?.(outcome.phase)
        consecutiveFailures = 0
        lastTransientError = null
        break
    }
  }

  const trailing = lastTransientError
    ? i18next.t('queue.pollLastError', { ns: 'lib', reason: describeError(lastTransientError) })
    : ''
  throw new Error(
    i18next.t('queue.pollTimeout', { ns: 'lib', seconds: POLL_MAX_MS / 1000, trailing }),
  )
}

async function fetchResultMeta(base: string, requestId: string): Promise<ResultResponse> {
  const url = `${base}/v1/queue/requests/${requestId}`
  const res = await authenticatedBffFetch(url)
  if (!res.ok) {
    throw new Error(
      i18next.t('queue.resultMetaFailed', { ns: 'lib', reason: await getApiErrorMessage(res) }),
    )
  }
  const json = (await res.json()) as ResultResponse
  if (json.status === 'failed') {
    throw new Error(json.error?.message ?? i18next.t('queue.taskFailed', { ns: 'lib' }))
  }
  if (json.status !== 'completed') {
    throw new Error(i18next.t('queue.notCompleted', { ns: 'lib', status: json.status }))
  }
  return json
}

export async function fetchImageDataUrl(
  base: string,
  requestId: string,
  index: number,
  fallbackMime: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${base}/v1/queue/requests/${requestId}/image/${index}`
  const res = await authenticatedBffFetch(url, { signal })
  if (!res.ok) {
    throw new Error(
      i18next.t('queue.imageFetchFailed', {
        ns: 'lib',
        index,
        reason: await getApiErrorMessage(res),
      }),
    )
  }
  const mime = res.headers.get('content-type') ?? fallbackMime
  return bytesToDataUrl(await res.arrayBuffer(), mime)
}

const QUALITY_LITERALS: Record<TaskParams['quality'], true> = {
  auto: true,
  low: true,
  medium: true,
  high: true,
}
const OUTPUT_FORMAT_LITERALS: Record<TaskParams['output_format'], true> = {
  png: true,
  jpeg: true,
  webp: true,
}

/**
 * 只保留查表命中的字面量。`=== true` 不能省：查表用的 key 来自上游 JSON，
 * 'constructor' 这类原型链上的键会返回真值。
 */
function pickLiteral<T extends string>(value: unknown, literals: Record<T, true>): T | undefined {
  if (typeof value !== 'string') return undefined
  return literals[value as T] === true ? (value as T) : undefined
}

/** BFF 用 string 透传实际参数；只保留 TaskParams 对应 union 接受的值。 */
function narrowActualParams(
  p: { size?: string; quality?: string; output_format?: string } | undefined,
): Partial<TaskParams> | undefined {
  if (!p) return undefined
  const out: Partial<TaskParams> = {}
  if (typeof p.size === 'string') out.size = p.size
  const quality = pickLiteral(p.quality, QUALITY_LITERALS)
  if (quality) out.quality = quality
  const outputFormat = pickLiteral(p.output_format, OUTPUT_FORMAT_LITERALS)
  if (outputFormat) out.output_format = outputFormat
  return Object.keys(out).length ? out : undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
