import type {
  ResultResponse,
  StatusResponse,
  SubmitResponse,
} from '@image-playground/shared'
import type { ImageApiResponse } from '../../types'
import { parseGeminiResponse, type GeminiResponse } from '../geminiImageApi'
import {
  assertImageInputPayloadSize,
  getApiErrorMessage,
  getDataUrlEncodedByteSize,
  MIME_MAP,
  type CallApiOptions,
  type CallApiResult,
} from '../imageApiShared'
import { parseOpenAICompatResponse } from './edgeClient'
import type { BuiltinEdgeProfile, PublicChannel } from './types'

const POLL_BACKOFF_MS = [500, 1000, 2000, 3000, 5000]
const POLL_MAX_MS = 30 * 60 * 1000 // 30 分钟硬上限

/**
 * Queue 模式：submit → polling → fetch result，把 BFF 转发的上游原始响应交给
 * 现有 OpenAI / Gemini parser 复用。
 *
 * 浏览器 ↔ BFF 全是 < 1s 短请求；BFF 在 mac mini 上用 localhost 调 sub2api，
 * 任务多久都不受 CF Edge 100s 限制。
 */
export async function callQueueChannelApi(
  opts: CallApiOptions,
  profile: BuiltinEdgeProfile,
  channel: PublicChannel,
): Promise<CallApiResult> {
  if (channel.kind !== 'openai-queue' && channel.kind !== 'gemini-queue') {
    throw new Error(`Not a queue channel: ${channel.kind}`)
  }
  if (channel.bffBaseUrl == null) {
    throw new Error(`queue channel ${channel.id} 缺少 bffBaseUrl`)
  }
  if (opts.maskDataUrl) {
    throw new Error('queue 模式暂不支持遮罩编辑（mask）')
  }
  assertImageInputPayloadSize(
    opts.inputImageDataUrls.reduce((sum, url) => sum + getDataUrlEncodedByteSize(url), 0),
  )

  const provider = channel.kind === 'openai-queue' ? 'openai-compat' : 'gemini'
  const model = profile.selectedModelId
  const base = channel.bffBaseUrl

  const requestId = await submit(base, provider, model, opts)
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

async function submit(
  base: string,
  provider: 'openai-compat' | 'gemini',
  model: string,
  opts: CallApiOptions,
): Promise<string> {
  const body: Record<string, unknown> = {
    prompt: opts.prompt,
  }
  if (opts.params.size && opts.params.size !== 'auto') body.size = opts.params.size
  if (opts.params.quality && opts.params.quality !== 'auto') body.quality = opts.params.quality
  if (opts.params.n && opts.params.n > 1) body.n = opts.params.n
  if (opts.inputImageDataUrls.length) body.input_images = opts.inputImageDataUrls

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
