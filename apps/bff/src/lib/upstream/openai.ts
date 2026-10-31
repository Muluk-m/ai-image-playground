import { Buffer, File } from 'node:buffer'
import { FormData } from 'undici'
import type { HydratedSubmitRequest } from '../imageArchive'
import { decodeDataUrl, type UpstreamCallResult } from './shared'

export function mergeOpenAIDataResults(results: UpstreamCallResult[]): UpstreamCallResult {
  const first = results[0]?.payload
  const firstPayload =
    first && typeof first === 'object' && !Array.isArray(first)
      ? (first as Record<string, unknown>)
      : {}
  return {
    payload: {
      ...firstPayload,
      data: results.flatMap((result) => {
        const payload = result.payload as { data?: unknown[] } | null
        return Array.isArray(payload?.data) ? payload.data : []
      }),
    },
  }
}

/** fan-out 的单次请求体用：去掉 n，让上游按默认的一张返回。 */
export function withoutImageCount(request: HydratedSubmitRequest): HydratedSubmitRequest {
  const { n: _n, ...singleRequest } = request
  return singleRequest
}

/**
 * Grok 网关对请求体里的 moderation 一律 403 `Request blocked by upstream content policy`，
 * 与内容是否违规无关。前端 chip 隐藏后 params.moderation 仍保留默认值并照发，
 * 这里是唯一的拦截点。extra 也要清：它最后 spread 进 body，绕过顶层字段。
 */
export function withoutModeration(request: HydratedSubmitRequest): HydratedSubmitRequest {
  const { moderation: _moderation, ...rest } = request
  if (!rest.extra || !('moderation' in rest.extra)) return rest
  const { moderation: _fromExtra, ...extra } = rest.extra
  return { ...rest, extra }
}

/**
 * 把 fan-out 的多次单图响应合并成一个 OpenAI 风格 payload。
 * 保留 data；单次响应的其它顶层字段（created / size / quality / output_format）丢弃，
 * 即 fan-out 结果没有 extractImages 的 actual_params。各条回报的 usage 逐项相加保留：
 * OpenAI 直连按它折算这一单的成本（upstream/gpt-budget.ts）。
 */
export function mergeOpenAIImageResults(
  results: readonly UpstreamCallResult[],
): UpstreamCallResult {
  const usage = sumImageUsage(
    results.map((result) => (result.payload as { usage?: unknown })?.usage),
  )
  return {
    payload: {
      data: results.flatMap((result) => {
        const payload = result.payload as { data?: unknown[] } | null
        return Array.isArray(payload?.data) ? payload.data : []
      }),
      ...(usage ? { usage } : {}),
    },
  }
}

interface ImageUsage {
  input_tokens: number
  output_tokens: number
  input_tokens_details: { image_tokens: number; text_tokens: number }
}

/** 每条都回了 usage 才相加；缺一条就不给（交给按档位估算），免得少算。 */
function sumImageUsage(items: readonly unknown[]): ImageUsage | undefined {
  if (items.length === 0) return undefined
  const total: ImageUsage = {
    input_tokens: 0,
    output_tokens: 0,
    input_tokens_details: { image_tokens: 0, text_tokens: 0 },
  }
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  for (const item of items) {
    const usage = item as Partial<ImageUsage> | undefined
    if (!usage || typeof usage.output_tokens !== 'number') return undefined
    total.input_tokens += num(usage.input_tokens)
    total.output_tokens += usage.output_tokens
    total.input_tokens_details.image_tokens += num(usage.input_tokens_details?.image_tokens)
    total.input_tokens_details.text_tokens += num(usage.input_tokens_details?.text_tokens)
  }
  return total
}

/**
 * Agnes 风格（agnes-generations-json）请求体：文生图与图生图同一端点同一 JSON 体，
 * 输入图放 extra_body.image（实测 top-level image 会被上游静默忽略）。
 * quality / n 上游不识别 → 不传（n 由 callUpstream fan-out 实现）。
 * 新增的 OpenAI / Gemini 参数也不传，避免上游拒绝或静默忽略未知字段。
 */
export function buildAgnesGenerationsBody(
  model: string,
  request: HydratedSubmitRequest,
): Record<string, unknown> {
  const { extra_body: extraBody, ...extraTop } = (request.extra ?? {}) as {
    extra_body?: Record<string, unknown>
    [k: string]: unknown
  }
  const mergedExtraBody: Record<string, unknown> = { ...(extraBody ?? {}) }
  if (request.input_images?.length) mergedExtraBody.image = request.input_images
  return {
    model,
    prompt: request.prompt,
    ...(request.size ? { size: request.size } : {}),
    ...extraTop,
    ...(Object.keys(mergedExtraBody).length ? { extra_body: mergedExtraBody } : {}),
  }
}

export function buildOpenAIBody(
  model: string,
  request: HydratedSubmitRequest,
): Record<string, unknown> {
  return {
    model,
    prompt: request.prompt,
    ...(request.size ? { size: request.size } : {}),
    ...(request.quality ? { quality: request.quality } : {}),
    ...(request.output_format ? { output_format: request.output_format } : {}),
    ...(request.moderation ? { moderation: request.moderation } : {}),
    ...(request.output_compression != null
      ? { output_compression: request.output_compression }
      : {}),
    ...(request.n ? { n: request.n } : {}),
    ...(request.extra ?? {}),
  }
}

/** 按 id 前缀认 GPT Image 家族：网关给的别名不带这个前缀就静默走回原 Images 协议。 */
export function isGptImageModel(model: string): boolean {
  return model.startsWith('gpt-image-')
}

interface OpenAIEditFiles {
  inputs: File[]
  mask?: File
}

function prepareOpenAIEditFiles(request: HydratedSubmitRequest): OpenAIEditFiles {
  return {
    inputs: (request.input_images ?? []).map((dataUrl) => dataUrlToFile(dataUrl, 'image.png')),
    ...(request.mask ? { mask: dataUrlToFile(request.mask, 'mask.png') } : {}),
  }
}

export function buildOpenAIEditFormData(model: string, request: HydratedSubmitRequest): FormData {
  const files = prepareOpenAIEditFiles(request)
  const form = new FormData()
  form.append('model', model)
  form.append('prompt', request.prompt)
  if (request.size) form.append('size', request.size)
  if (request.quality) form.append('quality', request.quality)
  if (request.output_format) form.append('output_format', request.output_format)
  if (request.moderation) form.append('moderation', request.moderation)
  if (request.output_compression != null) {
    form.append('output_compression', String(request.output_compression))
  }
  for (const input of files.inputs) form.append('image[]', input)
  if (files.mask) form.append('mask', files.mask)
  // edits 不接受 n；数量由本地 fan-out 实现。其余 extra 标量字段原样透传。
  for (const [k, v] of Object.entries(request.extra ?? {})) {
    if (k === 'n' || v == null) continue
    form.append(k, typeof v === 'string' ? v : JSON.stringify(v))
  }
  return form
}

function dataUrlToFile(dataUrl: string, filename: string): File {
  const { mime, bytes } = decodeDataUrl(dataUrl)
  return new File([Buffer.from(bytes)], filename, { type: mime })
}
