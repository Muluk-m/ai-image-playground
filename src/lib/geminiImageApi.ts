import type { ApiProfile, TaskParams } from '../types'
import {
  assertImageInputPayloadSize,
  type CallApiOptions,
  type CallApiResult,
  getApiErrorMessage,
  getDataUrlEncodedByteSize,
} from './imageApiShared'

export interface GeminiPart {
  text?: string
  inlineData?: { mimeType: string; data: string }
}

export interface GeminiRequestBody {
  contents: Array<{ role: 'user'; parts: GeminiPart[] }>
  generationConfig?: {
    responseModalities?: string[]
    imageConfig?: { aspectRatio: string }
    candidateCount?: number
  }
}

export interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] }
    finishReason?: string
  }>
}

export interface GeminiParseResult {
  images: string[]
  revisedPrompts: Array<string | undefined>
}

const ASPECT_RATIOS: Array<{ label: string; value: number }> = [
  { label: '1:1', value: 1 },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:4', value: 3 / 4 },
]

function nearestAspectRatio(size: string): string | undefined {
  const m = size.match(/^(\d+)x(\d+)$/i)
  if (!m) return undefined
  const w = Number(m[1])
  const h = Number(m[2])
  if (!w || !h) return undefined
  const ratio = w / h
  let best = ASPECT_RATIOS[0]
  let bestDelta = Math.abs(best.value - ratio)
  for (const candidate of ASPECT_RATIOS.slice(1)) {
    const delta = Math.abs(candidate.value - ratio)
    if (delta < bestDelta) {
      best = candidate
      bestDelta = delta
    }
  }
  return best.label
}

function dataUrlToInlinePart(dataUrl: string): GeminiPart | null {
  const m = dataUrl.match(/^data:([^;,]+);base64,(.*)$/i)
  if (!m) return null
  return { inlineData: { mimeType: m[1], data: m[2] } }
}

export function buildGeminiRequestBody(opts: {
  prompt: string
  inputImageDataUrls: string[]
  params: TaskParams
}): GeminiRequestBody {
  const parts: GeminiPart[] = [{ text: opts.prompt }]
  for (const url of opts.inputImageDataUrls) {
    const part = dataUrlToInlinePart(url)
    if (part) parts.push(part)
  }

  const generationConfig: GeminiRequestBody['generationConfig'] = {
    responseModalities: ['TEXT', 'IMAGE'],
  }
  const n = Math.max(1, opts.params.n || 1)
  if (n > 1) generationConfig.candidateCount = n
  const aspect = nearestAspectRatio(opts.params.size)
  if (aspect) generationConfig.imageConfig = { aspectRatio: aspect }

  return {
    contents: [{ role: 'user', parts }],
    generationConfig,
  }
}

export function parseGeminiResponse(payload: GeminiResponse): GeminiParseResult {
  const images: string[] = []
  const revisedPrompts: Array<string | undefined> = []

  for (const candidate of payload.candidates ?? []) {
    const parts = candidate.content?.parts ?? []
    const text = parts.map((p) => (typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n').trim() || undefined
    for (const part of parts) {
      if (!part.inlineData) continue
      const { mimeType, data } = part.inlineData
      if (!mimeType || !data) continue
      images.push(`data:${mimeType};base64,${data}`)
      revisedPrompts.push(text)
    }
  }

  if (!images.length) {
    const err = new Error('Gemini 未返回可用图片数据')
    ;(err as unknown as { rawResponsePayload: string }).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  return { images, revisedPrompts }
}

function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`
}

export async function callGeminiImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  if (opts.maskDataUrl) {
    throw new Error('Gemini 服务商不支持遮罩编辑，请改用 OpenAI 或 fal.ai 服务商')
  }

  assertImageInputPayloadSize(
    opts.inputImageDataUrls.reduce((sum, url) => sum + getDataUrlEncodedByteSize(url), 0),
  )

  const body = buildGeminiRequestBody({
    prompt: opts.prompt,
    inputImageDataUrls: opts.inputImageDataUrls,
    params: opts.params,
  })

  const url = joinUrl(profile.baseUrl, `models/${encodeURIComponent(profile.model)}:generateContent`)
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': profile.apiKey,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    throw new Error(await getApiErrorMessage(response))
  }

  const payload = (await response.json()) as GeminiResponse
  const parsed = parseGeminiResponse(payload)

  return {
    images: parsed.images,
    revisedPrompts: parsed.revisedPrompts,
    actualParamsList: parsed.images.map(() => undefined),
  }
}
