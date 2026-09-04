import { Agent, fetch as undiciFetch } from 'undici'
import { config } from '../config'
import { resolveApiKey } from './resolveApiKey'
import { isObject } from './type-guards'

/**
 * 复刻模式的竞品图分析：一张图一次 chat 调用，拿回结构化简报。
 * 独立于 upstream.ts —— 那里是生图队列的协议适配，超时预算按分钟算，这里按秒。
 */

export const SHOT_TYPES = [
  'main',
  'scene',
  'topdown',
  'detail',
  'selling-point',
  'spec-diagram',
  'other',
] as const

export type ShotType = (typeof SHOT_TYPES)[number]

export interface ProductBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface CompetitorBrief {
  readonly shotType: ShotType
  readonly composition: string
  readonly camera: string
  readonly lighting: string
  readonly background: string
  readonly props: string[]
  readonly textZones: string[]
  readonly palette: string[]
  readonly productBox: ProductBox | null
  readonly suggestedTitle?: string
}

export interface ProductContext {
  readonly name: string
  readonly description: string
}

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

function asShotType(value: unknown): ShotType | undefined {
  return SHOT_TYPES.find((type) => type === value)
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.every((item) => typeof item === 'string') ? value : undefined
}

function clampUnit(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(1, Math.max(0, value))
}

function asProductBox(value: unknown): ProductBox | null | undefined {
  if (value === null || value === undefined) return null
  if (!isObject(value)) return undefined
  const x = clampUnit(value.x)
  const y = clampUnit(value.y)
  const w = clampUnit(value.w)
  const h = clampUnit(value.h)
  if (x === undefined || y === undefined || w === undefined || h === undefined) return undefined
  return { x, y, w, h }
}

function asBrief(value: unknown): CompetitorBrief | undefined {
  if (!isObject(value)) return undefined
  const shotType = asShotType(value.shotType)
  const props = asStringArray(value.props)
  const textZones = asStringArray(value.textZones)
  const palette = asStringArray(value.palette)
  const productBox = asProductBox(value.productBox)
  if (!shotType || !props || !textZones || !palette || productBox === undefined) return undefined
  const { composition, camera, lighting, background, suggestedTitle } = value
  if (
    typeof composition !== 'string' ||
    typeof camera !== 'string' ||
    typeof lighting !== 'string' ||
    typeof background !== 'string'
  ) {
    return undefined
  }
  return {
    shotType,
    composition,
    camera,
    lighting,
    background,
    props,
    textZones,
    palette,
    productBox,
    ...(typeof suggestedTitle === 'string' ? { suggestedTitle } : {}),
  }
}

function messageContent(payload: unknown): string | undefined {
  if (!isObject(payload) || !Array.isArray(payload.choices)) return undefined
  const message = isObject(payload.choices[0]) ? payload.choices[0].message : undefined
  if (!isObject(message) || typeof message.content !== 'string') return undefined
  return message.content
}

async function requestBrief(image: string, product: ProductContext): Promise<string> {
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
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

async function analyzeImage(image: string, product: ProductContext): Promise<CompetitorBrief> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await requestBrief(image, product)
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      continue
    }
    const content = messageContent(payload)
    const brief = content === undefined ? undefined : asBrief(extractJson(content))
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
