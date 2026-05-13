import type {
  QueueProvider,
  ResultResponse,
  StatusResponse,
  SubmitResponse,
} from '@image-playground/shared'
import type { TaskParams } from '../../types'
import {
  applyCodexCliPromptGuard,
  assertImageInputPayloadSize,
  getApiErrorMessage,
  getDataUrlEncodedByteSize,
  type CallApiOptions,
  type CallApiResult,
} from '../imageApiShared'
import type { BuiltinEdgeProfile, ProviderKind, PublicChannel } from './types'

const POLL_BACKOFF_MS = [500, 1000, 2000, 3000, 5000]
const POLL_MAX_MS = 30 * 60 * 1000
/**
 * 连续这么多次「网络错误 / 5xx」就放弃。设计目的：BFF 抖动（重启空窗、
 * cf tunnel 重连）能容忍几次；但 BFF 真死了不会让前端傻等 30 分钟。
 * 4xx（包括 404）走「快错」路径，不计入此计数，立即抛错。
 */
const POLL_MAX_CONSECUTIVE_FAILURES = 5

/**
 * Queue 模式：submit → polling → fetch metadata → fetch each image binary。
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
  return await pollAndFetch(channel, base, requestId)
}

/**
 * 刷新页面恢复路径：跳过 submit，用持久化的 requestId 直接 poll+fetch。
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
  void provider
  void opts
  void profile
  const base = (channel.bffBaseUrl ?? '').replace(/\/+$/, '')
  return await pollAndFetch(channel, base, requestId)
}

async function pollAndFetch(
  channel: PublicChannel,
  base: string,
  requestId: string,
): Promise<CallApiResult> {
  await poll(base, requestId)
  const meta = await fetchResultMeta(base, requestId)
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
      meta.images.map((m) => fetchImageDataUrl(base, requestId, m.index, m.mime, downloadController.signal)),
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
  let consecutiveFailures = 0
  let lastTransientError: unknown = null

  for (let attempt = 0; Date.now() < deadline; attempt++) {
    await sleep(POLL_BACKOFF_MS[Math.min(attempt, POLL_BACKOFF_MS.length - 1)]!)

    let res: Response
    try {
      res = await fetch(url)
    } catch (err) {
      // 网络断 / DNS / CORS 都进这里。视为短暂故障，重试。
      consecutiveFailures++
      lastTransientError = err
      if (consecutiveFailures >= POLL_MAX_CONSECUTIVE_FAILURES) {
        throw new Error(`BFF 连续 ${POLL_MAX_CONSECUTIVE_FAILURES} 次连不上：${err instanceof Error ? err.message : String(err)}`)
      }
      continue
    }

    if (!res.ok) {
      if (res.status >= 500) {
        // 5xx 视为 BFF 短暂故障，按 consecutive failure 计数；超过阈值再放弃。
        consecutiveFailures++
        lastTransientError = new Error(`BFF status ${res.status}`)
        if (consecutiveFailures >= POLL_MAX_CONSECUTIVE_FAILURES) {
          throw new Error(`BFF 连续 ${POLL_MAX_CONSECUTIVE_FAILURES} 次返 ${res.status}：${await getApiErrorMessage(res)}`)
        }
        continue
      }
      // 4xx 是确定性错误（请求 ID 不存在 / 参数错），立即放弃，不重试。
      throw new Error(`BFF status 查询失败：${await getApiErrorMessage(res)}`)
    }

    consecutiveFailures = 0
    lastTransientError = null
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
  if (lastTransientError) {
    throw new Error(`BFF 任务超过 ${POLL_MAX_MS / 1000}s 未完成，最后一次错误：${lastTransientError instanceof Error ? lastTransientError.message : String(lastTransientError)}`)
  }
  throw new Error(`BFF 任务超过 ${POLL_MAX_MS / 1000}s 未完成`)
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
  const buf = await res.arrayBuffer()
  return arrayBufferToDataUrl(buf, mime)
}

function arrayBufferToDataUrl(buf: ArrayBuffer, mime: string): string {
  // 不用 FileReader，避免 vitest 默认 node 环境缺 FileReader 失败；
  // 浏览器侧表现一致。chunked 转 string 是因为 String.fromCharCode 超大字符数会爆栈。
  const bytes = new Uint8Array(buf)
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

const QUALITY_LITERALS = new Set<TaskParams['quality']>(['auto', 'low', 'medium', 'high'])

/** BFF 用 string 透传 quality；只保留 TaskParams.quality union 接受的值。 */
function narrowActualParams(p: { size?: string; quality?: string } | undefined): Partial<TaskParams> | undefined {
  if (!p) return undefined
  const out: Partial<TaskParams> = {}
  if (typeof p.size === 'string') out.size = p.size
  if (typeof p.quality === 'string' && QUALITY_LITERALS.has(p.quality as TaskParams['quality'])) {
    out.quality = p.quality as TaskParams['quality']
  }
  return Object.keys(out).length ? out : undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
