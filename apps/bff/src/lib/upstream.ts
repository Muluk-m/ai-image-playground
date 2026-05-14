import { QUEUE_TIMEOUTS, type QueueProvider, type SubmitRequest } from '@image-playground/shared'
import { config } from '../config'
import { resolveApiKey } from './resolveApiKey'

/**
 * 把 SubmitRequest 转换为 OpenAI Images / Gemini generateContent 请求体并发给 sub2api。
 *
 * BFF 不做参数翻译；OpenAI 路径走 /v1/images/generations（或 /edits 等），
 * Gemini 路径走 /v1beta/models/{model}:generateContent。
 *
 * sub2api 是本机 localhost，无 CF Edge / 跨网延迟。这里仍设 10 分钟硬超时，
 * 防止上游卡死时 BFF worker 永远 hang、task 永远停在 in_progress。
 */
export interface UpstreamCallParams {
  provider: QueueProvider
  model: string
  request: SubmitRequest
  signal?: AbortSignal
}

export interface UpstreamCallResult {
  payload: unknown
}

export async function callUpstream(params: UpstreamCallParams): Promise<UpstreamCallResult> {
  const { provider, model, request, signal: externalSignal } = params
  const base = config.sub2api.baseUrl

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS)
  const onExternalAbort = () => abort.abort()
  externalSignal?.addEventListener('abort', onExternalAbort)

  try {
    if (provider === 'openai-compat') {
      const key = resolveApiKey(provider)
      const res = await fetch(`${base}/v1/images/generations`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(buildOpenAIBody(model, request)),
        signal: abort.signal,
      })
      return parseUpstreamResponse(res)
    }

    if (provider === 'gemini') {
      const key = resolveApiKey(provider)
      const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`
      const headers = {
        'content-type': 'application/json',
        ...(key ? { 'x-api-key': key } : {}),
      }
      const body = JSON.stringify(buildGeminiBody(request))

      // Gemini image generation 不支持 candidateCount>1（"Only one candidate is
      // supported for audio or image response"），n>1 时本层 fan-out 成 N 次并发
      // 请求并把 candidates 合并到一个 payload，对 task-runner / 前端透明。
      const n = Math.max(1, request.n ?? 1)
      if (n === 1) {
        const res = await fetch(url, { method: 'POST', headers, body, signal: abort.signal })
        return parseUpstreamResponse(res)
      }

      const results = await Promise.all(
        Array.from({ length: n }, async () => {
          const res = await fetch(url, { method: 'POST', headers, body, signal: abort.signal })
          return parseUpstreamResponse(res)
        }),
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
    ...(request.input_images?.length ? { input_images: request.input_images } : {}),
    ...(request.extra ?? {}),
  }
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
