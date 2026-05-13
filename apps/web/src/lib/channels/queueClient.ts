import type {
  QueueProvider,
  ResultResponse,
  StatusResponse,
  SubmitResponse,
} from '@image-playground/shared'
import type { ImageApiResponse } from '../../types'
import { parseGeminiResponse, type GeminiResponse } from '../geminiImageApi'
import {
  applyCodexCliPromptGuard,
  assertImageInputPayloadSize,
  getApiErrorMessage,
  getDataUrlEncodedByteSize,
  MIME_MAP,
  type CallApiOptions,
  type CallApiResult,
} from '../imageApiShared'
import { parseOpenAICompatResponse } from './edgeClient'
import type { BuiltinEdgeProfile, ProviderKind, PublicChannel } from './types'

const POLL_BACKOFF_MS = [500, 1000, 2000, 3000, 5000]
const POLL_MAX_MS = 30 * 60 * 1000

/**
 * Queue 模式：submit → polling → fetch result。
 *
 * 浏览器 ↔ BFF 全是 < 1s 短请求；BFF 在 mac mini 上用 localhost 调 sub2api，
 * 任务多久都不受 CF Edge 100s 限制。
 *
 * channel.bffBaseUrl 缺省 / 空字符串视为同源（前端跟 BFF 同 cf tunnel 域名，
 * fetch 用相对路径走 BFF）。
 */
export async function callQueueChannelApi(
  opts: CallApiOptions,
  profile: BuiltinEdgeProfile,
  channel: PublicChannel,
): Promise<CallApiResult> {
  const provider = toQueueProvider(channel.kind)
  if (!provider) {
    throw new Error(`callQueueChannelApi: 不支持的 channel kind ${channel.kind}`)
  }
  if (opts.maskDataUrl) {
    throw new Error('queue 模式暂不支持遮罩编辑（mask），请改用其它 channel 或 BYOK profile')
  }
  assertImageInputPayloadSize(
    opts.inputImageDataUrls.reduce((sum, url) => sum + getDataUrlEncodedByteSize(url), 0),
  )

  const model = profile.selectedModelId
  const base = (channel.bffBaseUrl ?? '').replace(/\/+$/, '')
  const codexCli = Boolean(channel.defaults.codexCli)

  const requestId = await submit(base, provider, model, opts, codexCli, opts.clientRequestId)
  opts.onQueueSubmitted?.(requestId)
  return await pollAndParse(opts, channel, provider, base, requestId)
}

/**
 * 刷新页面恢复路径：跳过 submit，用持久化的 requestId 直接 poll+fetchResult。
 * 调用者需保证 channel.kind 是 queue 类型；不再次校验 maskDataUrl 等输入约束。
 */
export async function resumeQueueChannelApi(
  opts: CallApiOptions,
  profile: BuiltinEdgeProfile,
  channel: PublicChannel,
  requestId: string,
): Promise<CallApiResult> {
  const provider = toQueueProvider(channel.kind)
  if (!provider) {
    throw new Error(`resumeQueueChannelApi: 不支持的 channel kind ${channel.kind}`)
  }
  void profile
  const base = (channel.bffBaseUrl ?? '').replace(/\/+$/, '')
  return await pollAndParse(opts, channel, provider, base, requestId)
}

async function pollAndParse(
  opts: CallApiOptions,
  channel: PublicChannel,
  provider: QueueProvider,
  base: string,
  requestId: string,
): Promise<CallApiResult> {
  await poll(base, requestId)
  const payload = await fetchResult(base, requestId)

  if (provider === 'gemini') {
    const parsed = parseGeminiResponse(payload as GeminiResponse)
    return {
      images: parsed.images,
      revisedPrompts: parsed.revisedPrompts,
      actualParamsList: parsed.images.map(() => undefined),
    }
  }

  const mime = MIME_MAP[opts.params.output_format] ?? 'image/png'
  const downloadController = new AbortController()
  const timer = setTimeout(() => downloadController.abort(), (channel.defaults.timeout ?? 600) * 1000)
  try {
    return await parseOpenAICompatResponse(payload as ImageApiResponse, mime, downloadController.signal)
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
  // codex CLI 模式：prompt 加 guard 前缀 + quality 字段丢弃（codex 网关会拒绝）。
  // 跟 edgeClient OpenAI 路径行为对齐，由前端在 submit body 里直接应用。
  const body: Record<string, unknown> = {
    prompt: applyCodexCliPromptGuard(opts.prompt, codexCli),
  }
  if (opts.params.size && opts.params.size !== 'auto') body.size = opts.params.size
  if (!codexCli && opts.params.quality && opts.params.quality !== 'auto') body.quality = opts.params.quality
  if (opts.params.n && opts.params.n > 1) body.n = opts.params.n
  if (opts.inputImageDataUrls.length) body.input_images = opts.inputImageDataUrls
  if (clientRequestId) body.client_request_id = clientRequestId

  const url = `${base}/v1/queue/${provider}/${encodeURIComponent(model)}/submit`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`BFF submit 失败：${await getApiErrorMessage(res)}`)
  }
  const json = (await res.json()) as SubmitResponse
  if (!json.request_id) throw new Error('BFF submit 响应缺少 request_id')
  return json.request_id
}

async function poll(base: string, requestId: string): Promise<void> {
  const url = `${base}/v1/queue/requests/${requestId}/status`
  const deadline = Date.now() + POLL_MAX_MS

  for (let attempt = 0; Date.now() < deadline; attempt++) {
    await sleep(POLL_BACKOFF_MS[Math.min(attempt, POLL_BACKOFF_MS.length - 1)]!)
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`BFF status 查询失败：${await getApiErrorMessage(res)}`)
    }
    const json = (await res.json()) as StatusResponse
    if (json.status === 'completed') return
    if (json.status === 'failed') {
      throw new Error(json.error?.message ?? 'BFF 任务执行失败')
    }
    if (json.status === 'cancelled') {
      throw new Error('BFF 任务被取消')
    }
    // queued / in_progress: 继续
  }
  throw new Error(`BFF 任务超过 ${POLL_MAX_MS / 1000}s 未完成`)
}

async function fetchResult(base: string, requestId: string): Promise<unknown> {
  const url = `${base}/v1/queue/requests/${requestId}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`BFF result 拉取失败：${await getApiErrorMessage(res)}`)
  }
  const json = (await res.json()) as ResultResponse
  if (!json.payload) {
    throw new Error(json.error?.message ?? 'BFF 返回 completed 但缺少 payload')
  }
  return json.payload
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
