import {
  QUEUE_TIMEOUTS,
  type QueueProvider,
  type ResultResponse,
  type StatusResponse,
  type StatusResultMeta,
  type SubmitResponse,
} from '@image-playground/shared'
import type { TaskParams } from '../../types'
import { getDeviceId } from '../deviceId'
import {
  assertImageInputPayloadSize,
  bytesToDataUrl,
  type CallApiOptions,
  type CallApiResult,
  getApiErrorMessage,
  getDataUrlEncodedByteSize,
} from '../imageApiShared'
import { getRuntimeConfig } from '../runtimeConfig'
import { nearestAspectRatio } from '../size'
import type { BuiltinEdgeProfile, ProviderKind, PublicChannel } from './types'

const { POLL_BACKOFF_MS, POLL_MAX_MS, POLL_MAX_CONSECUTIVE_FAILURES } = QUEUE_TIMEOUTS

/**
 * Queue 模式：submit → polling → fetch metadata → fetch each image binary。
 *
 * 浏览器 ↔ BFF 全是 < 1s 短请求；BFF 用 localhost 调上游，任务多久都不受
 * 浏览器/Edge 长超时限制。
 *
 * BFF base URL 来自 `runtimeConfig.bff.baseUrl`：空字符串 = 同源（BFF 同进程
 * 托管前端 dist，最常见形态）；非空 = 跨域（如 cf tunnel），fetch 走绝对 URL。
 */
function bffBase(): string {
  return getRuntimeConfig().bff.baseUrl.replace(/\/+$/, '')
}

export async function callQueueChannelApi(
  opts: CallApiOptions,
  profile: BuiltinEdgeProfile,
  channel: PublicChannel,
): Promise<CallApiResult> {
  const provider = toQueueProvider(channel.kind)
  if (!provider) {
    throw new Error(`callQueueChannelApi: 不支持的 channel kind ${channel.kind}`)
  }
  assertImageInputPayloadSize(
    opts.inputImageDataUrls.reduce((sum, url) => sum + getDataUrlEncodedByteSize(url), 0),
  )

  const model = profile.selectedModelId
  const base = bffBase()
  const codexCli = Boolean(channel.defaults.codexCli)

  const requestId = await submit(base, provider, model, opts, codexCli, opts.clientRequestId)
  opts.onQueueSubmitted?.(requestId)
  return await pollAndFetch(channel, base, requestId)
}

/**
 * 刷新页面恢复路径：跳过 submit，用持久化的 requestId 直接 poll+fetch。
 */
export async function resumeQueueChannelApi(
  _opts: CallApiOptions,
  _profile: BuiltinEdgeProfile,
  channel: PublicChannel,
  requestId: string,
): Promise<CallApiResult> {
  // 校验 kind 合法但 resume 本身只用 channel + requestId — provider/opts/profile
  // 仅为跟 callQueueChannelApi 保持调用签名一致，恢复路径不需要重新构造请求。
  if (!toQueueProvider(channel.kind)) {
    throw new Error(`resumeQueueChannelApi: 不支持的 channel kind ${channel.kind}`)
  }
  return await pollAndFetch(channel, bffBase(), requestId)
}

async function pollAndFetch(
  channel: PublicChannel,
  base: string,
  requestId: string,
): Promise<CallApiResult> {
  // poll 拿到 completed 时 status response 已经内联了 meta（BFF 新协议）；缺失时
  // 才回退到 GET /result。少一次 RTT 是常态路径，fallback 走旧 BFF 版本。
  const inlined = await poll(base, requestId)
  const meta = inlined ?? (await fetchResultMeta(base, requestId))
  if (!meta.images?.length) {
    throw new Error('BFF 返回 completed 但 images 列表为空')
  }

  // 并发拉所有图片二进制，转 data URL 给上游既有存储路径用。
  // 单图慢的话仍是用户下行瓶颈，但绕开了 base64 33% 膨胀 + JSON 双重开销。
  const downloadController = new AbortController()
  const timer = setTimeout(
    () => downloadController.abort(),
    (channel.defaults.timeout ?? 600) * 1000,
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

  const url = `${base}/v1/queue/${provider}/${encodeURIComponent(model)}/submit`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    if (res.status === 429) {
      const json = (await res.json().catch(() => null)) as {
        error?: string
        reset_at?: string
      } | null
      if (json?.error === 'daily_quota_exceeded') {
        const err = new Error('今日 80 张已用完，UTC 0 点（北京 8 点）后重置') as Error & {
          quotaExceeded: boolean
          resetAt?: string
        }
        err.quotaExceeded = true
        if (json.reset_at) err.resetAt = json.reset_at
        throw err
      }
    }
    throw new Error(`BFF submit 失败：${await getApiErrorMessage(res)}`)
  }
  const json = (await res.json()) as SubmitResponse
  if (!json.request_id) throw new Error('BFF submit 响应缺少 request_id')
  return json.request_id
}

type PollOutcome =
  | { kind: 'done'; result: StatusResultMeta | undefined }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' }
  | { kind: 'pending' }
  /** 短暂错误（5xx / 网络抖动），按 consecutiveFailures 计数 */
  | { kind: 'transient'; error: unknown }
  /** 确定性错误（4xx），立即放弃 */
  | { kind: 'fatal'; message: string }

async function classifyPollResponse(url: string): Promise<PollOutcome> {
  let res: Response
  try {
    res = await fetch(url)
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
    return { kind: 'failed', message: json.error?.message ?? 'BFF 任务执行失败' }
  if (json.status === 'cancelled') return { kind: 'cancelled' }
  return { kind: 'pending' }
}

/**
 * 返回 completed 时附带的 result meta（新 BFF 内联），缺失则回 undefined 让调用方
 * 回退 GET /result。
 */
async function poll(base: string, requestId: string): Promise<StatusResultMeta | undefined> {
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
        throw new Error(outcome.message)
      case 'cancelled':
        throw new Error('BFF 任务被取消')
      case 'fatal':
        throw new Error(`BFF status 查询失败：${outcome.message}`)
      case 'transient': {
        consecutiveFailures++
        lastTransientError = outcome.error
        if (consecutiveFailures >= POLL_MAX_CONSECUTIVE_FAILURES) {
          const msg = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
          throw new Error(`BFF 连续 ${POLL_MAX_CONSECUTIVE_FAILURES} 次连不上：${msg}`)
        }
        break
      }
      case 'pending':
        consecutiveFailures = 0
        lastTransientError = null
        break
    }
  }

  const trailing = lastTransientError
    ? `，最后一次错误：${lastTransientError instanceof Error ? lastTransientError.message : String(lastTransientError)}`
    : ''
  throw new Error(`BFF 任务超过 ${POLL_MAX_MS / 1000}s 未完成${trailing}`)
}

async function fetchResultMeta(base: string, requestId: string): Promise<ResultResponse> {
  const url = `${base}/v1/queue/requests/${requestId}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`BFF result meta 拉取失败：${await getApiErrorMessage(res)}`)
  }
  const json = (await res.json()) as ResultResponse
  if (json.status === 'failed') {
    throw new Error(json.error?.message ?? 'BFF 任务执行失败')
  }
  if (json.status !== 'completed') {
    throw new Error(`BFF 返回非 completed 状态：${json.status}`)
  }
  return json
}

async function fetchImageDataUrl(
  base: string,
  requestId: string,
  index: number,
  fallbackMime: string,
  signal: AbortSignal,
): Promise<string> {
  const url = `${base}/v1/queue/requests/${requestId}/image/${index}`
  const res = await fetch(url, { signal })
  if (!res.ok) {
    throw new Error(`BFF image #${index} 拉取失败：${await getApiErrorMessage(res)}`)
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
