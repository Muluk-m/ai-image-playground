import type { TaskParams } from '../types'
import {
  assertImageInputPayloadSize,
  type BYOKAdapterProfile,
  type CallApiOptions,
  type CallApiResult,
  getApiErrorMessage,
  getDataUrlEncodedByteSize,
  throwIfProxyError,
} from './imageApiShared'
import { nearestAspectRatio } from './size'

export interface GeminiPart {
  text?: string
  inlineData?: { mimeType: string; data: string }
}

export interface GeminiRequestBody {
  contents: Array<{ role: 'user'; parts: GeminiPart[] }>
  generationConfig?: {
    responseModalities?: string[]
    imageConfig?: { aspectRatio?: string; imageSize?: string }
    candidateCount?: number
    thinkingConfig?: { thinkingLevel?: string }
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

  // gemini-3-pro-image-preview 强制要求同时声明 TEXT + IMAGE，否则返回 INVALID_ARGUMENT；
  // 2.5 Flash Image 对两种写法都接受。文档：https://ai.google.dev/gemini-api/docs/image-generation
  const generationConfig: GeminiRequestBody['generationConfig'] = {
    responseModalities: ['TEXT', 'IMAGE'],
  }

  const aspect = opts.params.gemini_aspect_ratio ?? nearestAspectRatio(opts.params.size)
  const imageSize = opts.params.gemini_image_size
  if (aspect || imageSize) {
    generationConfig.imageConfig = {
      ...(aspect ? { aspectRatio: aspect } : {}),
      ...(imageSize ? { imageSize } : {}),
    }
  }

  if (opts.params.gemini_thinking_level) {
    generationConfig.thinkingConfig = { thinkingLevel: opts.params.gemini_thinking_level }
  }

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
    const text =
      parts
        .map((p) => (typeof p.text === 'string' ? p.text : ''))
        .filter(Boolean)
        .join('\n')
        .trim() || undefined
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
    ;(err as unknown as { rawResponsePayload: string }).rawResponsePayload = JSON.stringify(
      payload,
      null,
      2,
    )
    throw err
  }

  return { images, revisedPrompts }
}

function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`
}

export async function callGeminiImageApi(
  opts: CallApiOptions,
  profile: BYOKAdapterProfile,
): Promise<CallApiResult> {
  if (opts.maskDataUrl) {
    throw new Error('Gemini 服务商不支持遮罩编辑，请改用 OpenAI 服务商')
  }

  assertImageInputPayloadSize(
    opts.inputImageDataUrls.reduce((sum, url) => sum + getDataUrlEncodedByteSize(url), 0),
  )

  const body = buildGeminiRequestBody({
    prompt: opts.prompt,
    inputImageDataUrls: opts.inputImageDataUrls,
    params: opts.params,
  })

  const url = joinUrl(
    profile.baseUrl,
    `models/${encodeURIComponent(profile.model)}:generateContent`,
  )
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // 使用 x-api-key 而不是 x-goog-api-key：浏览器端常见中转网关 CORS 白名单
    // 通常允许 x-api-key 但不允许 x-goog-api-key（后者会被 preflight 拦截）。
    // 后端代理通常同时接受这两种 header。
    'x-api-key': profile.apiKey,
  }
  const serialized = JSON.stringify(body)

  // Gemini image generation 不支持 candidateCount>1，n>1 改为并发 N 次单 candidate
  // 请求，最后合并图片。任一子请求失败整体失败（用户期望 n=N 就是 N 张图）。
  const n = Math.max(1, opts.params.n || 1)

  const parsedList = await Promise.all(
    Array.from({ length: n }, () => fetchAndParse(url, headers, serialized)),
  )

  const images = parsedList.flatMap((r) => r.images)
  const revisedPrompts = parsedList.flatMap((r) => r.revisedPrompts)
  return {
    images,
    revisedPrompts,
    actualParamsList: images.map(() => undefined),
  }
}

async function fetchAndParse(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<GeminiParseResult> {
  const response = await fetch(url, { method: 'POST', headers, body })
  if (!response.ok) {
    throw new Error(await getApiErrorMessage(response))
  }
  const payload = (await response.json()) as GeminiResponse
  throwIfProxyError(payload)
  return parseGeminiResponse(payload)
}
