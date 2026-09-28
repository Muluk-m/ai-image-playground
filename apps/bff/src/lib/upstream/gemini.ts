import type { HydratedSubmitRequest } from '../imageArchive'
import { DATA_URL_PATTERN, type UpstreamCallResult } from './shared'

export function mergeGeminiCandidateResults(results: UpstreamCallResult[]): UpstreamCallResult {
  return {
    payload: {
      candidates: results.flatMap((result) => {
        const payload = result.payload as { candidates?: unknown[] } | null
        return Array.isArray(payload?.candidates) ? payload.candidates : []
      }),
    },
  }
}

/** Google 家的图片入参形状；不是 data URL 返回 undefined，由调用方决定跳过还是报错。 */
export function inlineDataPart(
  dataUrl: string,
): { inlineData: { mimeType: string; data: string } } | undefined {
  const m = dataUrl.match(DATA_URL_PATTERN)
  return m ? { inlineData: { mimeType: m[1]!, data: m[2]! } } : undefined
}

export function buildGeminiBody(request: HydratedSubmitRequest): Record<string, unknown> {
  const parts: Array<Record<string, unknown>> = [{ text: request.prompt }]
  for (const dataUrl of request.input_images ?? []) {
    const part = inlineDataPart(dataUrl)
    if (part) parts.push(part)
  }

  const { generationConfig: extraGenerationConfig, ...extraTopLevel } = (request.extra ?? {}) as {
    generationConfig?: Record<string, unknown>
    [key: string]: unknown
  }
  const generationConfig: Record<string, unknown> = { responseModalities: ['IMAGE'] }
  if (request.aspect_ratio || request.image_size) {
    generationConfig.imageConfig = {
      ...(request.aspect_ratio ? { aspectRatio: request.aspect_ratio } : {}),
      ...(request.image_size ? { imageSize: request.image_size } : {}),
    }
  }
  if (request.thinking_level) {
    generationConfig.thinkingConfig = { thinkingLevel: request.thinking_level }
  }

  return {
    contents: [{ role: 'user', parts }],
    // extra.generationConfig 放最后：调用方显式给的配置压过这里从扁平参数推导的默认值。
    generationConfig: { ...generationConfig, ...extraGenerationConfig },
    ...extraTopLevel,
  }
}
