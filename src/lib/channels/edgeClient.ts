import { imageDataUrlToPngBlob, maskDataUrlToPngBlob } from '../canvasImage'
import { buildGeminiRequestBody, parseGeminiResponse, type GeminiResponse } from '../geminiImageApi'
import {
  assertImageInputPayloadSize,
  type CallApiOptions,
  type CallApiResult,
  fetchImageUrlAsDataUrl,
  getApiErrorMessage,
  getDataUrlEncodedByteSize,
  isDataUrl,
  isHttpUrl,
  mergeActualParams,
  MIME_MAP,
  normalizeBase64Image,
  pickActualParams,
} from '../imageApiShared'
import type { ImageApiResponse } from '../../types'
import type { BuiltinEdgeProfile, PublicChannel } from './types'

const EDGE_PROXY_PREFIX = '/api-proxy'

export function buildEdgeUrl(channelId: string, path: string): string {
  const normalizedPath = path.replace(/^\/+/, '')
  return `${EDGE_PROXY_PREFIX}/${channelId}/${normalizedPath}`
}

/**
 * 将 builtin-edge profile 的请求转发到同源 Pages Function /api-proxy/<channelId>/<path>。
 * 客户端永远不带 Authorization；Pages Function 注入凭据。
 */
export async function callEdgeChannelApi(
  opts: CallApiOptions,
  profile: BuiltinEdgeProfile,
  channel: PublicChannel,
): Promise<CallApiResult> {
  const model = profile.selectedModelId
  const timeoutMs = (channel.defaults.timeout ?? 600) * 1000

  assertImageInputPayloadSize(
    opts.inputImageDataUrls.reduce((sum, url) => sum + getDataUrlEncodedByteSize(url), 0),
  )

  if (channel.kind === 'gemini') {
    return callGeminiEdge(opts, profile.channelId, model, timeoutMs)
  }
  if (channel.kind === 'openai-compat') {
    return callOpenAICompatEdge(opts, profile.channelId, model, timeoutMs)
  }
  throw new Error(`不支持的 channel kind：${channel.kind}`)
}

async function callGeminiEdge(
  opts: CallApiOptions,
  channelId: string,
  model: string,
  timeoutMs: number,
): Promise<CallApiResult> {
  if (opts.maskDataUrl) {
    throw new Error('Gemini 服务商不支持遮罩编辑，请改用 OpenAI 服务商')
  }
  const body = buildGeminiRequestBody({
    prompt: opts.prompt,
    inputImageDataUrls: opts.inputImageDataUrls,
    params: opts.params,
  })
  const url = buildEdgeUrl(channelId, `models/${encodeURIComponent(model)}:generateContent`)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(await getApiErrorMessage(response))
    const payload = (await response.json()) as GeminiResponse
    const parsed = parseGeminiResponse(payload)
    return {
      images: parsed.images,
      revisedPrompts: parsed.revisedPrompts,
      actualParamsList: parsed.images.map(() => undefined),
    }
  } finally {
    clearTimeout(timer)
  }
}

async function callOpenAICompatEdge(
  opts: CallApiOptions,
  channelId: string,
  model: string,
  timeoutMs: number,
): Promise<CallApiResult> {
  const isEdit = opts.inputImageDataUrls.length > 0 || Boolean(opts.maskDataUrl)
  const path = isEdit ? 'images/edits' : 'images/generations'
  const url = buildEdgeUrl(channelId, path)
  const mime = MIME_MAP[opts.params.output_format] ?? 'image/png'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = isEdit
      ? await sendOpenAICompatEdit(url, model, opts, controller.signal)
      : await sendOpenAICompatGenerate(url, model, opts, controller.signal)
    if (!response.ok) throw new Error(await getApiErrorMessage(response))
    const payload = (await response.json()) as ImageApiResponse
    return parseOpenAICompatResponse(payload, mime, controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

async function sendOpenAICompatGenerate(
  url: string,
  model: string,
  opts: CallApiOptions,
  signal: AbortSignal,
): Promise<Response> {
  const body: Record<string, unknown> = {
    model,
    prompt: opts.prompt,
    size: opts.params.size,
    quality: opts.params.quality,
    output_format: opts.params.output_format,
    moderation: opts.params.moderation,
  }
  if (opts.params.output_compression != null) body.output_compression = opts.params.output_compression
  if (opts.params.n && opts.params.n > 1) body.n = opts.params.n

  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
}

async function sendOpenAICompatEdit(
  url: string,
  model: string,
  opts: CallApiOptions,
  signal: AbortSignal,
): Promise<Response> {
  const formData = new FormData()
  formData.append('model', model)
  formData.append('prompt', opts.prompt)
  formData.append('size', opts.params.size)
  formData.append('quality', opts.params.quality)
  formData.append('output_format', opts.params.output_format)
  formData.append('moderation', opts.params.moderation)
  if (opts.params.output_compression != null) {
    formData.append('output_compression', String(opts.params.output_compression))
  }
  if (opts.params.n && opts.params.n > 1) formData.append('n', String(opts.params.n))
  for (const dataUrl of opts.inputImageDataUrls) {
    const blob = await imageDataUrlToPngBlob(dataUrl)
    formData.append('image[]', blob, 'image.png')
  }
  if (opts.maskDataUrl) {
    const maskBlob = await maskDataUrlToPngBlob(opts.maskDataUrl)
    formData.append('mask', maskBlob, 'mask.png')
  }
  return fetch(url, { method: 'POST', body: formData, signal })
}

async function parseOpenAICompatResponse(
  payload: ImageApiResponse,
  mime: string,
  signal: AbortSignal,
): Promise<CallApiResult> {
  const data = Array.isArray(payload?.data) ? payload.data : []
  if (!data.length) {
    const err = new Error('接口未返回图片数据')
    ;(err as unknown as { rawResponsePayload: string }).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  const images: string[] = []
  const rawImageUrls = data.map((item) => item.url).filter(isHttpUrl)
  const revisedPrompts: Array<string | undefined> = []
  try {
    for (const item of data) {
      if (typeof item.b64_json === 'string' && item.b64_json) {
        images.push(normalizeBase64Image(item.b64_json, mime))
        revisedPrompts.push(typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined)
        continue
      }
      if (isHttpUrl(item.url) || isDataUrl(item.url)) {
        images.push(await fetchImageUrlAsDataUrl(item.url, mime, signal))
        revisedPrompts.push(typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined)
      }
    }
  } catch (err) {
    if (rawImageUrls.length > 0 && err instanceof Error) {
      ;(err as unknown as { rawImageUrls: string[] }).rawImageUrls = rawImageUrls
    }
    throw err
  }

  if (!images.length) {
    const err = new Error('接口未返回可识别的图片数据')
    ;(err as unknown as { rawResponsePayload: string }).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  const actualParams = mergeActualParams(pickActualParams(payload))
  return {
    images,
    actualParams,
    actualParamsList: images.map(() => actualParams),
    revisedPrompts,
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
  }
}
