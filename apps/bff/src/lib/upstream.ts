import { QUEUE_TIMEOUTS, type QueueProvider, type SubmitRequest } from '@image-playground/shared'
import { config } from '../config'
import { log } from './logger'
import { resolveApiKey } from './resolveApiKey'

/**
 * 把 SubmitRequest 转换为 OpenAI Images / Gemini generateContent 请求体并发给上游 API。
 *
 * BFF 不做参数翻译；OpenAI 路径根据是否带 input_images 选 /v1/images/edits（multipart）
 * 或 /v1/images/generations（JSON），Gemini 路径走 /v1beta/models/{model}:generateContent。
 *
 * 同机部署时 upstream 是 localhost，无 Edge / 跨网延迟。这里仍设硬超时
 * (QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS)，防止上游卡死时 BFF worker
 * 永远 hang、task 永远停在 in_progress。
 */
/** Agnes 模型需要走独立 baseUrl + key，这里集中做 provider → baseUrl/key 路由。 */
function resolveUpstreamBaseUrlAndKey(
  provider: QueueProvider,
  model: string,
): { baseUrl: string; authHeader: Record<string, string> } {
  if (provider === 'openai-compat' && model === 'agnes-image-2.1-flash') {
    const key = resolveApiKey('agnes')
    return {
      baseUrl: config.upstream.agnesBaseUrl,
      authHeader: key ? { authorization: `Bearer ${key}` } : {},
    }
  }
  const key = resolveApiKey(provider)
  return {
    baseUrl: config.upstream.baseUrl,
    authHeader: key ? { authorization: `Bearer ${key}` } : {},
  }
}

export interface UpstreamCallParams {
  provider: QueueProvider
  model: string
  request: SubmitRequest
  signal?: AbortSignal
}

export interface UpstreamCallResult {
  payload: unknown
}

/**
 * 自定义错误：BFF 自己的 UPSTREAM_HARD_TIMEOUT_MS 切的（vs 上游返 4xx/5xx
 * 或 socket 异常关）。task-runner 用 instanceof 检查并落库 error_type=
 * 'upstream_timeout'，便于前端给针对性文案。
 */
export class UpstreamTimeoutError extends Error {
  constructor(message = 'Upstream call exceeded BFF hard timeout') {
    super(message)
    this.name = 'UpstreamTimeoutError'
  }
}

/**
 * Bun 1.3.8 的 client fetch 默认有约 5min 的 socket idleTimeout（非标准
 * RequestInit 扩展，未在公开 docs 列出）。生图 multipart 一次发完后等响应
 * 期间 socket 零数据流动 → idle → Bun 自动关闭 → fetch 抛 "The operation
 * timed out."。
 *
 * 之前试过 `idleTimeout: 0` 想关掉它，实测同一 BFF 进程同一份代码出现：275s
 * 成功 / 252s 又被切，**Bun 不可靠地把 0 当成「禁用」**（很可能解析为
 * fallback 到 default）。改成显式大值 16min = 比 UPSTREAM_HARD_TIMEOUT_MS
 * (15min) 长 1min，确保 AbortController 总能先于 Bun socket idle 触发。
 *
 * 同时强制 `Connection: close`：Bun 默认走 HTTP/1.1 keepalive，pooled socket
 * 可能仍带初次建连时的 5min 默认 idle；每次开新连接最稳妥。同机部署 upstream
 * 是 localhost，新连接成本可忽略。
 */
type FetchInitWithIdle = RequestInit & { idleTimeout?: number }
const FETCH_IDLE_TIMEOUT_MS = 16 * 60 * 1000
const FETCH_NO_IDLE: { idleTimeout: number } = { idleTimeout: FETCH_IDLE_TIMEOUT_MS }
const NO_KEEPALIVE: Record<string, string> = { connection: 'close' }

export async function callUpstream(params: UpstreamCallParams): Promise<UpstreamCallResult> {
  const { provider, model, request, signal: externalSignal } = params
  const { baseUrl: base, authHeader } = resolveUpstreamBaseUrlAndKey(provider, model)

  const abort = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    abort.abort()
  }, QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS)
  const onExternalAbort = () => abort.abort()
  externalSignal?.addEventListener('abort', onExternalAbort)

  const fetchInit = (init: FetchInitWithIdle): FetchInitWithIdle => ({
    ...init,
    signal: abort.signal,
    ...FETCH_NO_IDLE,
  })

  const wrapTimeout = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p
    } catch (err) {
      if (timedOut) throw new UpstreamTimeoutError()
      throw err
    }
  }

  try {
    if (provider === 'openai-compat') {
      // 有参考图 / 有遮罩 → /v1/images/edits multipart；generations 是纯文生图，
      // 塞 input_images 字段上游会忽略（用户感知"AI 不参考附件"）。
      if (request.input_images?.length || request.mask) {
        const res = await wrapTimeout(
          fetch(
            `${base}/v1/images/edits`,
            fetchInit({
              method: 'POST',
              headers: { ...authHeader, ...NO_KEEPALIVE },
              body: buildOpenAIEditFormData(model, request),
            }),
          ),
        )
        return parseUpstreamResponse(res)
      }
      const res = await wrapTimeout(
        fetch(
          `${base}/v1/images/generations`,
          fetchInit({
            method: 'POST',
            headers: { 'content-type': 'application/json', ...authHeader, ...NO_KEEPALIVE },
            body: JSON.stringify(buildOpenAIBody(model, request)),
          }),
        ),
      )
      return parseUpstreamResponse(res)
    }

    if (provider === 'gemini') {
      const key = resolveApiKey(provider)
      const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`
      const headers = {
        'content-type': 'application/json',
        ...(key ? { 'x-api-key': key } : {}),
        ...NO_KEEPALIVE,
      }
      const body = JSON.stringify(buildGeminiBody(request))

      // Gemini image generation 不支持 candidateCount>1（"Only one candidate is
      // supported for audio or image response"），n>1 时本层 fan-out 成 N 次并发
      // 请求并把 candidates 合并到一个 payload，对 task-runner / 前端透明。
      const n = Math.max(1, request.n ?? 1)
      if (n === 1) {
        const res = await wrapTimeout(fetch(url, fetchInit({ method: 'POST', headers, body })))
        return parseUpstreamResponse(res)
      }

      const results = await wrapTimeout(
        Promise.all(
          Array.from({ length: n }, async () => {
            const res = await fetch(url, fetchInit({ method: 'POST', headers, body }))
            return parseUpstreamResponse(res)
          }),
        ),
      )
      const merged = {
        candidates: results.flatMap((r) => {
          const p = r.payload as { candidates?: unknown[] } | null
          return Array.isArray(p?.candidates) ? p.candidates : []
        }),
      }
      return { payload: merged }
    }

    throw new Error(`Unsupported provider: ${provider satisfies never}`)
  } finally {
    clearTimeout(timer)
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }
}

function buildOpenAIBody(model: string, request: SubmitRequest): Record<string, unknown> {
  return {
    model,
    prompt: request.prompt,
    ...(request.size ? { size: request.size } : {}),
    ...(request.quality ? { quality: request.quality } : {}),
    ...(request.n ? { n: request.n } : {}),
    ...(request.extra ?? {}),
  }
}

function buildOpenAIEditFormData(model: string, request: SubmitRequest): FormData {
  const form = new FormData()
  form.append('model', model)
  form.append('prompt', request.prompt)
  if (request.size) form.append('size', request.size)
  if (request.quality) form.append('quality', request.quality)
  if (request.n) form.append('n', String(request.n))
  for (const dataUrl of request.input_images ?? []) {
    form.append('image[]', dataUrlToBlob(dataUrl), 'image.png')
  }
  if (request.mask) {
    form.append('mask', dataUrlToBlob(request.mask), 'mask.png')
  }
  // request.extra 内的标量值原样以字段透传；image/mask 这类二进制不通过 extra 走。
  for (const [k, v] of Object.entries(request.extra ?? {})) {
    if (v == null) continue
    form.append(k, typeof v === 'string' ? v : JSON.stringify(v))
  }
  return form
}

function dataUrlToBlob(dataUrl: string): Blob {
  const m = dataUrl.match(/^data:([^;,]+);base64,(.*)$/i)
  if (!m) throw new Error('input_images 中的数据 URL 格式无效，必须是 data:<mime>;base64,<...>')
  const mime = m[1]!
  const bin = atob(m[2]!)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

function buildGeminiBody(request: SubmitRequest): Record<string, unknown> {
  const parts: Array<Record<string, unknown>> = [{ text: request.prompt }]
  for (const dataUrl of request.input_images ?? []) {
    const m = dataUrl.match(/^data:([^;,]+);base64,(.*)$/i)
    if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } })
  }

  const { generationConfig: extraGenerationConfig, ...extraTopLevel } = (request.extra ?? {}) as {
    generationConfig?: Record<string, unknown>
    [key: string]: unknown
  }

  return {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      ...(extraGenerationConfig ?? {}),
    },
    ...extraTopLevel,
  }
}

/** 非 2xx 时打 log 落的 payload 截断上限，避免上游回 base64 巨长串吞内存。 */
const UPSTREAM_ERROR_LOG_BYTES = 2000

async function parseUpstreamResponse(res: Response): Promise<UpstreamCallResult> {
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
        payloadPreview:
          typeof payload === 'object' && payload !== null
            ? JSON.stringify(payload).slice(0, UPSTREAM_ERROR_LOG_BYTES)
            : String(payload).slice(0, UPSTREAM_ERROR_LOG_BYTES),
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
