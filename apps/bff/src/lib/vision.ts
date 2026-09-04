import {
  type CompetitorBrief,
  type ProductContext,
  parseCompetitorBrief,
  SHOT_TYPES,
} from '@image-playground/shared'
import { Agent, fetch as undiciFetch } from 'undici'
import { config } from '../config'
import { resolveApiKey } from './resolveApiKey'
import { isObject } from './type-guards'

// 独立于 upstream.ts：那里是生图队列的协议适配，超时预算按分钟算，这里按秒。

export class VisionUpstreamError extends Error {
  constructor(readonly status: number) {
    super(`Vision upstream returned ${status}`)
    this.name = 'VisionUpstreamError'
  }
}

export class VisionInvalidResponseError extends Error {
  constructor() {
    super('Vision model did not return a usable brief')
    this.name = 'VisionInvalidResponseError'
  }
}

interface VisionResponse {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}

type VisionFetch = (
  input: Parameters<typeof undiciFetch>[0],
  init?: Parameters<typeof undiciFetch>[1],
) => Promise<VisionResponse>

const CONNECT_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 60_000

const visionDispatcher = new Agent({
  connectTimeout: CONNECT_TIMEOUT_MS,
  headersTimeout: REQUEST_TIMEOUT_MS,
  bodyTimeout: REQUEST_TIMEOUT_MS,
})

let visionFetch: VisionFetch = undiciFetch

/** 测试注入点；undefined 恢复真实 Undici transport。 */
export function setVisionFetchForTesting(fetchImpl?: VisionFetch): void {
  visionFetch = fetchImpl ?? undiciFetch
}

const INSTRUCTIONS = `You analyse one competitor product photo so a different product can be shot the same way.
Answer with a single JSON object and nothing else. Keys:
"shotType": one of ${SHOT_TYPES.map((type) => `"${type}"`).join(', ')}
"composition": one sentence on layout and subject placement
"camera": one sentence on angle, height and lens feel
"lighting": one sentence on direction, quality and mood
"background": one sentence on setting and surfaces
"props": array of short strings, one per visible prop
"textZones": array of short strings, one per block of on-image text, saying where it sits
"palette": array of hex colours, most dominant first
"productBox": {"x","y","w","h"} normalised to 0-1 for the product's bounding box, or null when no product is visible
"suggestedTitle": optional short label for this shot`

function promptFor(product: ProductContext): string {
  const description = product.description.trim()
  return `${INSTRUCTIONS}\n\nThe product that will replace the one in the photo: ${product.name}${
    description ? `. ${description}` : ''
  }`
}

function extractJson(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = (fenced?.[1] ?? content).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return undefined
  }
}

function messageContent(raw: string): string | undefined {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isObject(payload) || !Array.isArray(payload.choices)) return undefined
  const message = isObject(payload.choices[0]) ? payload.choices[0].message : undefined
  if (!isObject(message) || typeof message.content !== 'string') return undefined
  return message.content
}

/** 上游回的 chat 文本，形状不对时 undefined —— 交给调用方决定重试还是放弃。 */
async function requestContent(image: string, product: ProductContext): Promise<string | undefined> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await visionFetch(`${config.upstream.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${resolveApiKey('openai-compat')}`,
      },
      body: JSON.stringify({
        model: config.remix.visionModel,
        max_tokens: 1500,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: promptFor(product) },
              { type: 'image_url', image_url: { url: image } },
            ],
          },
        ],
      }),
      signal: abort.signal,
      dispatcher: visionDispatcher,
    })
    if (!response.ok) throw new VisionUpstreamError(response.status)
    return messageContent(await response.text())
  } finally {
    clearTimeout(timer)
  }
}

async function analyzeImage(image: string, product: ProductContext): Promise<CompetitorBrief> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const content = await requestContent(image, product)
    const brief = content === undefined ? null : parseCompetitorBrief(extractJson(content))
    if (brief) return brief
  }
  throw new VisionInvalidResponseError()
}

export function analyzeCompetitorImages(
  images: readonly string[],
  product: ProductContext,
): Promise<CompetitorBrief[]> {
  return Promise.all(images.map((image) => analyzeImage(image, product)))
}
