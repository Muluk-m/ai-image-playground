import type { QueueProvider, SubmitRequest } from '@image-playground/shared'
import { config } from '../config'

/**
 * 把 SubmitRequest 转换为 OpenAI Images / Gemini generateContent 请求体并发给 sub2api。
 *
 * BFF 不做参数翻译；OpenAI 路径就走 /v1/images/generations（或 /edits 等），
 * Gemini 路径走 /v1beta/models/{model}:generateContent。
 *
 * sub2api 自部署且 BFF 本机调，无 CF Edge / 跨网超时；不设 fetch 超时，让上游决定。
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
  const { provider, model, request, signal } = params
  const base = config.sub2api.baseUrl
  const key = config.sub2api.apiKey

  if (provider === 'openai-compat') {
    const url = `${base}/v1/images/generations`
    const body = {
      model,
      prompt: request.prompt,
      ...(request.size ? { size: request.size } : {}),
      ...(request.quality ? { quality: request.quality } : {}),
      ...(request.n ? { n: request.n } : {}),
      ...(request.input_images?.length ? { input_images: request.input_images } : {}),
      ...(request.extra ?? {}),
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    })
    return parseUpstreamResponse(res, provider)
  }

  if (provider === 'gemini') {
    const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`
    const parts: Array<Record<string, unknown>> = [{ text: request.prompt }]
    for (const dataUrl of request.input_images ?? []) {
      const m = dataUrl.match(/^data:([^;,]+);base64,(.*)$/i)
      if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } })
    }
    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        ...(request.n && request.n > 1 ? { candidateCount: request.n } : {}),
        ...(request.extra?.generationConfig as Record<string, unknown> | undefined),
      },
      ...(request.extra && typeof request.extra === 'object'
        ? Object.fromEntries(
            Object.entries(request.extra).filter(([k]) => k !== 'generationConfig'),
          )
        : {}),
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { 'x-api-key': key } : {}),
      },
      body: JSON.stringify(body),
      signal,
    })
    return parseUpstreamResponse(res, provider)
  }

  throw new Error(`Unsupported provider: ${provider satisfies never}`)
}

async function parseUpstreamResponse(res: Response, provider: QueueProvider): Promise<UpstreamCallResult> {
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
