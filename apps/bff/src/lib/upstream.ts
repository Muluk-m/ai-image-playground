import type { QueueProvider, SubmitRequest } from '@image-playground/shared'
import { config } from '../config'

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

const UPSTREAM_HARD_TIMEOUT_MS = 10 * 60 * 1000

export async function callUpstream(params: UpstreamCallParams): Promise<UpstreamCallResult> {
  const { provider, model, request, signal: externalSignal } = params
  const base = config.sub2api.baseUrl
  const key = config.sub2api.apiKey

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), UPSTREAM_HARD_TIMEOUT_MS)
  const onExternalAbort = () => abort.abort()
  externalSignal?.addEventListener('abort', onExternalAbort)

  try {
    if (provider === 'openai-compat') {
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
      const res = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { 'x-api-key': key } : {}),
        },
        body: JSON.stringify(buildGeminiBody(request)),
        signal: abort.signal,
      })
      return parseUpstreamResponse(res)
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
      ...(request.n && request.n > 1 ? { candidateCount: request.n } : {}),
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
