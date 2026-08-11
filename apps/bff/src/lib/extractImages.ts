import { Buffer } from 'node:buffer'
import type { QueueProvider, ResultImageMeta } from '@image-playground/shared'
import type { TaskBlobInput } from './blobStore'

/**
 * 从上游原始响应 payload 抽出图片元数据，不解码 base64 像素字节。
 * `b64ProviderRef` 返回一个 closure，提供给 binary endpoint 按 index 提取字节。
 */
export interface ExtractedResult {
  images: ResultImageMeta[]
  /** OpenAI response_format=url 时上游给的 http URL 列表（前端做合规展示用） */
  raw_image_urls?: string[]
  /** OpenAI 返回的实际 size / quality / output_format 等 */
  actual_params?: { size?: string; quality?: string; output_format?: string }
}

interface ImageBytesRef {
  /** 'b64' = base64 in payload；'url' = 上游 http url，BFF 需现拉 */
  kind: 'b64' | 'url'
  /** kind=b64 时是 base64 字符串；kind=url 时是 url */
  data: string
  mime: string
}

export function extractMeta(provider: QueueProvider, payload: unknown): ExtractedResult {
  const providerMeta =
    provider === 'openai-compat' ? extractOpenAI(payload) : extractGemini(payload)
  const archivedImages = extractArchivedImageMeta(payload)
  return archivedImages ? { ...providerMeta, images: archivedImages } : providerMeta
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return asRecord(payload) ?? {}
}

/**
 * 像素已外置的 payload 只留标记：`_image_meta` 是归档后的图片列表，
 * `_images_dropped` 表示归档失败、这次结果没有图。返回 null = 不是归档 payload，
 * 交回 provider 解析器按原始响应抽取。
 */
function extractArchivedImageMeta(payload: unknown): ResultImageMeta[] | null {
  const record = asRecord(payload)
  if (!record) return null
  if (record._images_dropped === true) return []
  const marker = record._image_meta
  if (!Array.isArray(marker)) return null

  const images: ResultImageMeta[] = []
  for (const value of marker) {
    const image = asRecord(value)
    if (!image) return null
    if (!Number.isInteger(image.index) || typeof image.mime !== 'string') return null
    const result: ResultImageMeta = { index: Number(image.index), mime: image.mime }
    if (typeof image.revised_prompt === 'string') result.revised_prompt = image.revised_prompt
    if (typeof image.width === 'number') result.width = image.width
    if (typeof image.height === 'number') result.height = image.height
    images.push(result)
  }
  return images
}

function stripOpenAIB64(
  payload: Record<string, unknown>,
  blobs?: TaskBlobInput[],
): Record<string, unknown> {
  if (!Array.isArray(payload.data)) return payload
  // 与 extractMeta 的 images[].index 对齐：b64 与 url 条目都参与编号，只有 b64 需要外置。
  let normalizedIndex = 0
  const data = payload.data.map((value) => {
    const item = asRecord(value)
    if (!item) return value
    const b64 = typeof item.b64_json === 'string' && item.b64_json ? item.b64_json : null
    const hasUrl = typeof item.url === 'string' && item.url !== ''
    if (!b64 && !hasUrl) return value

    const index = normalizedIndex++
    if (!b64) return value
    blobs?.push({ kind: 'output', idx: index, mime: 'image/png', data: Buffer.from(b64, 'base64') })
    const { b64_json: _pixelBytes, ...rest } = item
    return rest
  })
  return { ...payload, data }
}

function stripGeminiB64(
  payload: Record<string, unknown>,
  blobs?: TaskBlobInput[],
): Record<string, unknown> {
  if (!Array.isArray(payload.candidates)) return payload
  let normalizedIndex = 0
  const candidates = payload.candidates.map((candidateValue) => {
    const candidate = asRecord(candidateValue)
    const content = candidate && asRecord(candidate.content)
    const parts = content?.parts
    if (!candidate || !content || !Array.isArray(parts)) return candidateValue

    const strippedParts = parts.map((partValue) => {
      const part = asRecord(partValue)
      const inlineData = part && asRecord(part.inlineData)
      if (!part || !inlineData) return partValue
      if (typeof inlineData.data !== 'string' || !inlineData.data) return partValue

      const index = normalizedIndex++
      blobs?.push({
        kind: 'output',
        idx: index,
        mime: typeof inlineData.mimeType === 'string' ? inlineData.mimeType : 'image/png',
        data: Buffer.from(inlineData.data, 'base64'),
      })
      const { data: _pixelBytes, ...restInlineData } = inlineData
      return { ...part, inlineData: restInlineData }
    })
    return { ...candidate, content: { ...content, parts: strippedParts } }
  })
  return { ...payload, candidates }
}

export function externalizeResultImages(
  provider: QueueProvider,
  payload: unknown,
): { payload: Record<string, unknown>; blobs: TaskBlobInput[] } {
  const source = payloadRecord(payload)
  const images = extractMeta(provider, source).images
  const blobs: TaskBlobInput[] = []
  const stripped =
    provider === 'openai-compat' ? stripOpenAIB64(source, blobs) : stripGeminiB64(source, blobs)
  return { payload: { ...stripped, _image_meta: images }, blobs }
}

export function markResultImagesDropped(payload: unknown): Record<string, unknown> {
  const source = payloadRecord(payload)
  return {
    ...stripGeminiB64(stripOpenAIB64(source)),
    _images_dropped: true,
  }
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
    output_format?: string
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
  p: { size?: string; quality?: string; output_format?: string } | null,
): ExtractedResult['actual_params'] {
  if (!p) return undefined
  const out: NonNullable<ExtractedResult['actual_params']> = {}
  if (typeof p.size === 'string') out.size = p.size
  if (typeof p.quality === 'string') out.quality = p.quality
  if (typeof p.output_format === 'string') out.output_format = p.output_format
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
