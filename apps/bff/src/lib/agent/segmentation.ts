import type { AgentMaskPromptPoint, AgentNormalizedBox } from '@image-playground/shared'
import sharp from 'sharp'
import { config } from '../../config'
import { log } from '../logger'
import type { AgentFetch } from './model'
import { providerFetch } from './provider-fetch'

/**
 * 修改范围提议的服务端分割。接口只有这一层：换模型（fal SAM 3、自建、别家）只换实现，
 * 提议工具与卡片不跟着改。没有配置任何实现时返回 null，由浏览器分割或按框兜底。
 */
export interface SegmentationRequest {
  /** 原图 data URL；分割在原图坐标上做，蒙版与原图同尺寸。 */
  readonly dataUrl: string
  readonly width: number
  readonly height: number
  /** 给分割模型的短名词，英文效果最好（SAM 3 的文本提示）。 */
  readonly prompt: string
  readonly box: AgentNormalizedBox
  readonly points?: readonly AgentMaskPromptPoint[]
  readonly signal?: AbortSignal
}

/** 单通道二值蒙版：与原图同尺寸，255 = 目标，0 = 其余。 */
export interface SegmentationMask {
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
  readonly score?: number
}

export interface SegmentationProvider {
  readonly id: string
  segment(request: SegmentationRequest): Promise<readonly SegmentationMask[]>
}

export class SegmentationError extends Error {}

let providerOverride: SegmentationProvider | null | undefined
let falFetchOverride: AgentFetch | undefined

export function setSegmentationProviderForTesting(provider?: SegmentationProvider | null): void {
  providerOverride = provider
}

export function setFalFetchForTesting(fetchImpl?: AgentFetch): void {
  falFetchOverride = fetchImpl
}

/** 此刻可用的服务端分割；缺 key 或显式关闭时为 null。 */
export function segmentationProvider(): SegmentationProvider | null {
  if (providerOverride !== undefined) return providerOverride
  const { provider, falKey } = config.agent.segmentation
  if (provider === 'fal-sam3' && falKey) return falSam3(falKey)
  return null
}

const FAL_ORIGIN = 'https://fal.run'
const FAL_SAM3_PATH = '/fal-ai/sam-3/image'
const FAL_TIMEOUT_MS = 30_000
const FAL_MAX_MASKS = 3

interface FalImage {
  readonly url?: unknown
}
interface FalResponse {
  readonly masks?: readonly FalImage[]
  readonly scores?: readonly unknown[]
  readonly metadata?: readonly { readonly index?: unknown; readonly score?: unknown }[]
}

function pixelBox(box: AgentNormalizedBox, width: number, height: number) {
  return {
    x_min: Math.max(0, Math.floor(box.x * width)),
    y_min: Math.max(0, Math.floor(box.y * height)),
    x_max: Math.min(width - 1, Math.ceil((box.x + box.width) * width - 1e-6)),
    y_max: Math.min(height - 1, Math.ceil((box.y + box.height) * height - 1e-6)),
  }
}

/** 把一张 PNG 蒙版（任意通道、可能被缩放过）读成原图尺寸的单通道二值图。 */
export async function binaryMask(
  bytes: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const { data, info } = await sharp(bytes)
    .resize(width, height, { fit: 'fill', kernel: 'nearest' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const out = new Uint8Array(width * height)
  for (let i = 0; i < out.length; i++) {
    const at = i * info.channels
    // 白底黑字或带透明底的蒙版都认：亮且不透明才算目标。
    const luma = (data[at]! + data[at + 1]! + data[at + 2]!) / 3
    out[i] = luma >= 128 && data[at + 3]! >= 128 ? 255 : 0
  }
  return out
}

/** fal SAM 3 的请求体：文本提示加模型给的框与提示点，要多张候选并带分数，结果直接回 data URI。 */
export function falSam3Body(request: SegmentationRequest) {
  return {
    image_url: request.dataUrl,
    prompt: request.prompt,
    box_prompts: [pixelBox(request.box, request.width, request.height)],
    point_prompts: (request.points ?? []).map((point) => ({
      x: Math.round(point.x * request.width),
      y: Math.round(point.y * request.height),
      label: point.include ? 1 : 0,
    })),
    apply_mask: false,
    sync_mode: true,
    output_format: 'png',
    return_multiple_masks: true,
    max_masks: FAL_MAX_MASKS,
    include_scores: true,
  }
}

/** 解出 fal 的回包；外链不跟（不替上游去拉任意地址），只认 sync_mode 的 data URI。 */
export async function falSam3Masks(
  body: unknown,
  width: number,
  height: number,
): Promise<SegmentationMask[]> {
  const parsed = (body && typeof body === 'object' ? body : {}) as FalResponse
  const masks = Array.isArray(parsed.masks) ? parsed.masks.slice(0, FAL_MAX_MASKS) : []
  const decoded: SegmentationMask[] = []
  for (const [index, mask] of masks.entries()) {
    const url = typeof mask?.url === 'string' ? mask.url : ''
    const match = /^data:image\/[a-z+.-]+;base64,(.+)$/i.exec(url)
    if (!match) continue
    const score = parsed.scores?.[index] ?? parsed.metadata?.[index]?.score
    decoded.push({
      data: await binaryMask(Buffer.from(match[1]!, 'base64'), width, height),
      width,
      height,
      ...(typeof score === 'number' && Number.isFinite(score) ? { score } : {}),
    })
  }
  return decoded
}

function falSam3(key: string): SegmentationProvider {
  return {
    id: 'fal-sam3',
    async segment(request) {
      const fetchImpl = providerFetch(falFetchOverride ?? (fetch as AgentFetch), FAL_ORIGIN)
      const timeout = AbortSignal.timeout(FAL_TIMEOUT_MS)
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout
      const response = await fetchImpl(`${FAL_ORIGIN}${FAL_SAM3_PATH}`, {
        method: 'POST',
        headers: { authorization: `Key ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(falSam3Body(request)),
        signal,
      }).catch((error) => {
        throw new SegmentationError('fal request failed', { cause: error })
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new SegmentationError(`fal HTTP ${response.status}`)
      }
      const decoded = await falSam3Masks(
        await response.json().catch(() => null),
        request.width,
        request.height,
      )
      if (!decoded.length) throw new SegmentationError('fal returned no usable mask')
      return decoded
    },
  }
}

function maskBounds(mask: SegmentationMask) {
  let minX = mask.width,
    minY = mask.height,
    maxX = -1,
    maxY = -1,
    area = 0
  for (let y = 0; y < mask.height; y++)
    for (let x = 0; x < mask.width; x++) {
      if (!mask.data[y * mask.width + x]) continue
      area++
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  return area ? { minX, minY, maxX: maxX + 1, maxY: maxY + 1, area } : null
}

/** 模型给的框与蒙版外接框的交并比；两者都在原图像素坐标里。 */
export function boxAgreement(mask: SegmentationMask, box: AgentNormalizedBox): number {
  const bounds = maskBounds(mask)
  if (!bounds) return 0
  const bx0 = box.x * mask.width,
    by0 = box.y * mask.height,
    bx1 = (box.x + box.width) * mask.width,
    by1 = (box.y + box.height) * mask.height
  const ix = Math.max(0, Math.min(bounds.maxX, bx1) - Math.max(bounds.minX, bx0))
  const iy = Math.max(0, Math.min(bounds.maxY, by1) - Math.max(bounds.minY, by0))
  const inter = ix * iy
  const union =
    (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY) + (bx1 - bx0) * (by1 - by0) - inter
  return union > 0 ? inter / union : 0
}

/** 最低框一致度：低于它就当分割认错了对象，退回按框。 */
export const MIN_BOX_AGREEMENT = 0.3

/** 置信度乘框一致度取最高的那张；都对不上框时返回 null。 */
export function pickMask(
  masks: readonly SegmentationMask[],
  box: AgentNormalizedBox,
): SegmentationMask | null {
  let best: SegmentationMask | null = null
  let bestValue = 0
  for (const mask of masks) {
    const agreement = boxAgreement(mask, box)
    if (agreement < MIN_BOX_AGREEMENT) continue
    const value = (mask.score ?? 1) * agreement
    if (value > bestValue) {
      best = mask
      bestValue = value
    }
  }
  return best
}

/** 跑一次服务端分割；任何失败都只记一笔并返回 null，提议照常走浏览器或按框。 */
export async function segmentProposal(request: SegmentationRequest) {
  const provider = segmentationProvider()
  if (!provider) return null
  const startedAt = Date.now()
  try {
    const masks = await provider.segment(request)
    const picked = pickMask(masks, request.box)
    log.info(
      {
        event: 'agent.segmentation',
        provider: provider.id,
        masks: masks.length,
        picked: Boolean(picked),
        elapsedMs: Date.now() - startedAt,
      },
      'edit region segmentation finished',
    )
    return picked ? { provider: provider.id, mask: picked } : null
  } catch (error) {
    log.warn(
      {
        event: 'agent.segmentation_failed',
        provider: provider.id,
        elapsedMs: Date.now() - startedAt,
        err: error instanceof Error ? error.message : String(error),
      },
      'edit region segmentation failed; falling back',
    )
    return null
  }
}
