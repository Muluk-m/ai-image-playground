import type { QueueProvider, ResultImageMeta } from '@image-playground/shared'

/**
 * 从上游原始响应 payload 抽出图片元数据，不解码 base64 像素字节。
 * `b64ProviderRef` 返回一个 closure，提供给 binary endpoint 按 index 提取字节。
 */
export interface ExtractedResult {
  images: ResultImageMeta[]
  /** OpenAI response_format=url 时上游给的 http URL 列表（前端做合规展示用） */
  raw_image_urls?: string[]
  /** OpenAI 返回的实际 size 等 */
  actual_params?: { size?: string; quality?: string }
}

interface ImageBytesRef {
  /** 'b64' = base64 in payload；'url' = 上游 http url，BFF 需现拉 */
  kind: 'b64' | 'url'
  /** kind=b64 时是 base64 字符串；kind=url 时是 url */
  data: string
  mime: string
}

export function extractMeta(provider: QueueProvider, payload: unknown): ExtractedResult {
  if (provider === 'openai-compat') return extractOpenAI(payload)
  if (provider === 'gemini') return extractGemini(payload)
  // exhaustiveness guard
  const _exhaustive: never = provider
  void _exhaustive
  return { images: [] }
}

export function resolveImageBytesRef(
  provider: QueueProvider,
  payload: unknown,
  index: number,
): ImageBytesRef | null {
  if (provider === 'openai-compat') return resolveOpenAIBytes(payload, index)
  if (provider === 'gemini') return resolveGeminiBytes(payload, index)
  return null
}

/**
 * 上游 HTTP 200 但 extractMeta 没解出图片的兜底解释，用于 task-runner 把
 * "成功返回但没图" 翻译成 failed 状态。最常见原因：Gemini RECITATION /
 * IMAGE_SAFETY 拒绝（candidates[0].finishReason + finishMessage），或 OpenAI
 * 返回 body 里夹了 error envelope。
 */
export function describeEmptyResult(provider: QueueProvider, payload: unknown): string {
  if (provider === 'gemini') return describeGeminiEmpty(payload)
  if (provider === 'openai-compat') return describeOpenAIEmpty(payload)
  return '上游未返回图像数据'
}

interface GeminiCandidate {
  finishReason?: string
  finishMessage?: string
  content?: { parts?: GeminiPart[] }
}

function describeGeminiEmpty(payload: unknown): string {
  const p = payload as {
    candidates?: GeminiCandidate[]
    promptFeedback?: { blockReason?: string; blockReasonMessage?: string }
  } | null

  const cand = p?.candidates?.[0]
  if (cand?.finishReason) {
    const msg = typeof cand.finishMessage === 'string' ? cand.finishMessage.trim() : ''
    return msg ? `Gemini ${cand.finishReason}: ${msg}` : `Gemini ${cand.finishReason}`
  }
  if (p?.promptFeedback?.blockReason) {
    const msg = p.promptFeedback.blockReasonMessage ?? ''
    return msg
      ? `Gemini prompt blocked (${p.promptFeedback.blockReason}): ${msg}`
      : `Gemini prompt blocked: ${p.promptFeedback.blockReason}`
  }
  const text = (cand?.content?.parts ?? [])
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
  if (text) {
    const snippet = text.length > 300 ? `${text.slice(0, 300)}…` : text
    return `Gemini 未返回图像，仅文本：${snippet}`
  }
  return 'Gemini 未返回图像数据'
}

function describeOpenAIEmpty(payload: unknown): string {
  const p = payload as { error?: { message?: string } | string; message?: string } | null
  if (typeof p?.error === 'string') return `OpenAI: ${p.error}`
  if (p?.error && typeof p.error === 'object' && typeof p.error.message === 'string') {
    return `OpenAI: ${p.error.message}`
  }
  if (typeof p?.message === 'string') return `OpenAI: ${p.message}`
  return 'OpenAI 未返回图像数据'
}

function extractOpenAI(payload: unknown): ExtractedResult {
  const p = payload as {
    data?: Array<Record<string, unknown>>
    size?: string
    quality?: string
  } | null
  const data = Array.isArray(p?.data) ? p.data : []
  const images: ResultImageMeta[] = []
  const rawUrls: string[] = []
  for (let i = 0; i < data.length; i++) {
    const item = data[i]!
    const revised = typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined
    const url = typeof item.url === 'string' ? item.url : undefined
    if (url && /^https?:\/\//i.test(url)) rawUrls.push(url)
    if (typeof item.b64_json === 'string' && item.b64_json) {
      images.push({ index: images.length, mime: 'image/png', revised_prompt: revised })
    } else if (url) {
      images.push({ index: images.length, mime: 'image/png', revised_prompt: revised })
    }
  }
  return {
    images,
    raw_image_urls: rawUrls.length ? rawUrls : undefined,
    actual_params: pickActualOpenAI(p),
  }
}

function pickActualOpenAI(
  p: { size?: string; quality?: string } | null,
): ExtractedResult['actual_params'] {
  if (!p) return undefined
  const out: NonNullable<ExtractedResult['actual_params']> = {}
  if (typeof p.size === 'string') out.size = p.size
  if (typeof p.quality === 'string') out.quality = p.quality
  return Object.keys(out).length ? out : undefined
}

function resolveOpenAIBytes(payload: unknown, index: number): ImageBytesRef | null {
  const p = payload as { data?: Array<Record<string, unknown>> } | null
  const item = p?.data?.[index]
  if (!item) return null
  if (typeof item.b64_json === 'string' && item.b64_json) {
    return { kind: 'b64', data: item.b64_json, mime: 'image/png' }
  }
  if (typeof item.url === 'string' && /^https?:\/\//i.test(item.url)) {
    return { kind: 'url', data: item.url, mime: 'image/png' }
  }
  return null
}

interface GeminiPart {
  text?: string
  inlineData?: { mimeType?: string; data?: string }
}

function extractGemini(payload: unknown): ExtractedResult {
  const p = payload as { candidates?: Array<{ content?: { parts?: GeminiPart[] } }> } | null
  const images: ResultImageMeta[] = []
  for (const candidate of p?.candidates ?? []) {
    const parts = candidate.content?.parts ?? []
    const text =
      parts
        .map((part) => (typeof part.text === 'string' ? part.text : ''))
        .filter(Boolean)
        .join('\n')
        .trim() || undefined
    for (const part of parts) {
      if (!part.inlineData?.data) continue
      images.push({
        index: images.length,
        mime: part.inlineData.mimeType || 'image/png',
        revised_prompt: text,
      })
    }
  }
  return { images }
}

function resolveGeminiBytes(payload: unknown, index: number): ImageBytesRef | null {
  const p = payload as { candidates?: Array<{ content?: { parts?: GeminiPart[] } }> } | null
  let count = 0
  for (const candidate of p?.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (!part.inlineData?.data) continue
      if (count === index) {
        return {
          kind: 'b64',
          data: part.inlineData.data,
          mime: part.inlineData.mimeType || 'image/png',
        }
      }
      count++
    }
  }
  return null
}
