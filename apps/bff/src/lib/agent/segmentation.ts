import type { AgentMaskPromptPoint, AgentNormalizedBox } from '@image-playground/shared'
import sharp from 'sharp'
import { config } from '../../config'
import { log } from '../logger'
import type { AgentFetch } from './model'
import { providerFetch } from './provider-fetch'

/**
 * 修改范围提议与卡片点选的服务端分割。接口只有这一层：换模型（自建 EdgeTAM、fal SAM 3、别家）
 * 只换实现，提议工具与卡片不跟着改。没有配置任何实现时返回 null，卡片按智能体给的框兜底。
 */
export interface SegmentationRequest {
  /**
   * 原图 data URL。自建服务按 `key` 缓存了这张图的编码时根本不用读原图，所以也可以只给
   * `loadDataUrl`，真要发图时再取。
   */
  readonly dataUrl?: string
  readonly loadDataUrl?: () => Promise<string>
  /** 同一张原图的稳定缓存键，例如 `media:<mediaId>`；自建服务据此复用图像编码。 */
  readonly key?: string
  /** 原图像素宽高；坐标按它归一化，`segmentProposal` 交回的蒙版也是这个尺寸。 */
  readonly width: number
  readonly height: number
  /** 给分割模型的短名词，英文效果最好（SAM 3 的文本提示）。 */
  readonly prompt: string
  readonly box: AgentNormalizedBox
  readonly points?: readonly AgentMaskPromptPoint[]
  readonly signal?: AbortSignal
}

/**
 * 单通道二值蒙版，255 = 目标，0 = 其余。实现可以交回缩小过的蒙版（自建服务按 ≤1024 边长出），
 * `segmentProposal` 选定后再放大回原图尺寸。
 */
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
let segmenterFetchOverride: typeof fetch | undefined

export function setSegmentationProviderForTesting(provider?: SegmentationProvider | null): void {
  providerOverride = provider
}

export function setFalFetchForTesting(fetchImpl?: AgentFetch): void {
  falFetchOverride = fetchImpl
}

export function setSegmenterFetchForTesting(fetchImpl?: typeof fetch): void {
  segmenterFetchOverride = fetchImpl
}

/**
 * 此刻可用的服务端分割：部署注入了自建 EdgeTAM 服务地址就用它；否则有 fal key 用 SAM 3；
 * 显式 `off` 或什么都没配时为 null。
 */
export function segmentationProvider(): SegmentationProvider | null {
  if (providerOverride !== undefined) return providerOverride
  const { provider, falKey, segmenterUrl } = config.agent.segmentation
  if (provider === 'off') return null
  if (segmenterUrl) return edgeTam(segmenterUrl)
  if (provider === 'fal-sam3' && falKey) return falSam3(falKey)
  return null
}

async function requestDataUrl(request: SegmentationRequest): Promise<string> {
  const dataUrl = request.dataUrl ?? (await request.loadDataUrl?.())
  if (!dataUrl) throw new SegmentationError('source image unavailable')
  return dataUrl
}

/** 自建服务的单次预算：卡片打开、点一下都要等它，超时就退回智能体给的框。 */
export const SEGMENTER_TIMEOUT_MS = 3_000
/** 发给自建服务的图与它交回的蒙版的最长边；放大回原图在 BFF 做。 */
export const SEGMENTER_MAX_SIDE = 1024
const SEGMENTER_JPEG_QUALITY = 90

/** 原图按最长边缩到 ≤1024 后的尺寸。 */
export function segmenterSize(width: number, height: number) {
  const scale = Math.min(1, SEGMENTER_MAX_SIDE / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

interface SegmenterResponse {
  readonly width?: unknown
  readonly height?: unknown
  readonly masks?: readonly { readonly score?: unknown; readonly bits?: unknown }[]
  readonly error?: unknown
}

/** 服务端按行优先、高位在前打包的一位蒙版，解成 0/255。 */
export function unpackMaskBits(bits: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height)
  if (bits.length * 8 < out.length) throw new SegmentationError('mask bits too short')
  for (let i = 0; i < out.length; i++) out[i] = (bits[i >> 3]! >> (7 - (i & 7))) & 1 ? 255 : 0
  return out
}

export function segmenterMasks(body: unknown, width: number, height: number): SegmentationMask[] {
  const parsed = (body && typeof body === 'object' ? body : {}) as SegmenterResponse
  if (parsed.width !== width || parsed.height !== height)
    throw new SegmentationError('segmenter returned an unexpected mask size')
  const masks: SegmentationMask[] = []
  for (const mask of Array.isArray(parsed.masks) ? parsed.masks : []) {
    if (typeof mask?.bits !== 'string') continue
    masks.push({
      data: unpackMaskBits(Buffer.from(mask.bits, 'base64'), width, height),
      width,
      height,
      ...(typeof mask.score === 'number' && Number.isFinite(mask.score)
        ? { score: mask.score }
        : {}),
    })
  }
  return masks
}

/** 缩到 ≤1024 的 JPEG：只在自建服务没缓存这张图时才发。不转 EXIF 方向，与原图像素坐标一致。 */
async function segmenterImage(request: SegmentationRequest, width: number, height: number) {
  const dataUrl = await requestDataUrl(request)
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
  const jpeg = await sharp(bytes, { limitInputPixels: false })
    .resize(width, height, { fit: 'fill' })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: SEGMENTER_JPEG_QUALITY })
    .toBuffer()
  return jpeg.toString('base64')
}

/**
 * 自建 EdgeTAM 服务（deploy/segmenter）：先只发缓存键与提示，服务没见过这张图（404）再带上
 * 缩小的原图重发。一次请求不超过 {@link SEGMENTER_TIMEOUT_MS}。
 */
function edgeTam(origin: string): SegmentationProvider {
  const url = `${origin.replace(/\/+$/, '')}/v1/segment`
  return {
    id: 'edgetam',
    async segment(request) {
      const fetchImpl = segmenterFetchOverride ?? fetch
      const timeout = AbortSignal.timeout(SEGMENTER_TIMEOUT_MS)
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout
      const output = segmenterSize(request.width, request.height)
      const box = request.box
      const prompt = {
        box: [box.x, box.y, box.x + box.width, box.y + box.height],
        points: (request.points ?? []).map((point) => [point.x, point.y, point.include ? 1 : 0]),
        output,
      }
      const call = async (image?: string) => {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            key: request.key ?? `once:${crypto.randomUUID()}`,
            ...(image ? { image } : {}),
            ...prompt,
          }),
          signal,
        }).catch((error) => {
          throw new SegmentationError('segmenter request failed', { cause: error })
        })
        return response
      }
      let response = request.key ? await call() : undefined
      if (!response || response.status === 404) {
        await response?.body?.cancel()
        response = await call(await segmenterImage(request, output.width, output.height))
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new SegmentationError(`segmenter HTTP ${response.status}`)
      }
      const masks = segmenterMasks(
        await response.json().catch(() => null),
        output.width,
        output.height,
      )
      if (!masks.length) throw new SegmentationError('segmenter returned no usable mask')
      return masks
    },
  }
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
export function falSam3Body(request: SegmentationRequest & { readonly dataUrl: string }) {
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
      const dataUrl = await requestDataUrl(request)
      const fetchImpl = providerFetch(falFetchOverride ?? (fetch as AgentFetch), FAL_ORIGIN)
      const timeout = AbortSignal.timeout(FAL_TIMEOUT_MS)
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout
      const response = await fetchImpl(`${FAL_ORIGIN}${FAL_SAM3_PATH}`, {
        method: 'POST',
        headers: { authorization: `Key ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(falSam3Body({ ...request, dataUrl })),
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

/**
 * 外扩半径：4–8px，随原图尺寸增长（约每 256px 长边 1px）。外扩让边缘的发丝、阴影过渡与
 * 抗锯齿那一圈进入重绘区，合成回原图时不留硬边。
 */
export function dilationRadius(width: number, height: number): number {
  return Math.min(8, Math.max(4, Math.round(Math.max(width, height) / 256)))
}

/** 二值图的方形外扩，行、列各扫两遍，与半径无关的线性时间。0/255 进，0/255 出。 */
export function dilateMask(
  source: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  if (radius <= 0) return source.slice()
  const rows = new Uint8Array(source.length)
  for (let y = 0; y < height; y++) {
    const base = y * width
    let last = -Infinity
    for (let x = 0; x < width; x++) {
      if (source[base + x]) last = x
      if (x - last <= radius) rows[base + x] = 255
    }
    last = Infinity
    for (let x = width - 1; x >= 0; x--) {
      if (source[base + x]) last = x
      if (last - x <= radius) rows[base + x] = 255
    }
  }
  const out = new Uint8Array(source.length)
  for (let x = 0; x < width; x++) {
    let last = -Infinity
    for (let y = 0; y < height; y++) {
      if (rows[y * width + x]) last = y
      if (y - last <= radius) out[y * width + x] = 255
    }
    last = Infinity
    for (let y = height - 1; y >= 0; y--) {
      if (rows[y * width + x]) last = y
      if (last - y <= radius) out[y * width + x] = 255
    }
  }
  return out
}

/** 选中的蒙版放大回原图尺寸（平滑放大后取阈值，边缘不起锯齿），再外扩。 */
export async function shapeMask(
  mask: SegmentationMask,
  width: number,
  height: number,
  radius = dilationRadius(width, height),
): Promise<SegmentationMask> {
  let binary: Uint8Array
  if (mask.width === width && mask.height === height) {
    binary = new Uint8Array(width * height)
    for (let i = 0; i < binary.length; i++) binary[i] = mask.data[i]! >= 128 ? 255 : 0
  } else {
    // sharp 对单通道 raw 也可能交回三通道，按 info.channels 取第一个通道。
    const { data, info } = await sharp(Buffer.from(mask.data), {
      raw: { width: mask.width, height: mask.height, channels: 1 },
    })
      .resize(width, height, { fit: 'fill', kernel: 'cubic' })
      .raw()
      .toBuffer({ resolveWithObject: true })
    binary = new Uint8Array(width * height)
    for (let i = 0; i < binary.length; i++) binary[i] = data[i * info.channels]! >= 128 ? 255 : 0
  }
  return {
    data: dilateMask(binary, width, height, radius),
    width,
    height,
    ...(mask.score === undefined ? {} : { score: mask.score }),
  }
}

/** 提示点要是落在框外（用户在卡片上往外点），框跟着放大到把它们都包进来，再留一点边。 */
export function promptBox(
  box: AgentNormalizedBox,
  points: readonly AgentMaskPromptPoint[] | undefined,
): AgentNormalizedBox {
  const included = (points ?? []).filter((point) => point.include)
  if (!included.length) return box
  const margin = 0.02
  let x0 = box.x,
    y0 = box.y,
    x1 = box.x + box.width,
    y1 = box.y + box.height
  for (const point of included) {
    if (point.x < x0) x0 = Math.max(0, point.x - margin)
    if (point.y < y0) y0 = Math.max(0, point.y - margin)
    if (point.x > x1) x1 = Math.min(1, point.x + margin)
    if (point.y > y1) y1 = Math.min(1, point.y + margin)
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/**
 * 跑一次服务端分割：三张候选里按「置信度 × 与框的交并比」取一张，放大回原图并外扩。
 * 任何失败都只记一笔并返回 null，调用方按框兜底。
 */
export async function segmentProposal(request: SegmentationRequest) {
  const provider = segmentationProvider()
  if (!provider) return null
  const startedAt = Date.now()
  try {
    const masks = await provider.segment(request)
    const segmentedMs = Date.now() - startedAt
    const chosen = pickMask(masks, request.box)
    const picked = chosen ? await shapeMask(chosen, request.width, request.height) : null
    log.info(
      {
        event: 'agent.segmentation',
        provider: provider.id,
        masks: masks.length,
        picked: Boolean(picked),
        segmentedMs,
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

/** 探针至多这么久跑一次：公开接口，不能让人借它把分割服务一直占着。 */
const PROBE_INTERVAL_MS = 30_000
let lastProbe: { at: number; result: SegmenterProbe } | null = null
let probeSequence = 0

export interface SegmenterProbe {
  /** 新图：编码加一次解码的往返。 */
  readonly firstMs: number
  /** 同一张图再点一下：只解码的往返。 */
  readonly clickMs: number
  readonly server?: unknown
  readonly at: number
}

export function resetSegmenterProbeForTesting(): void {
  lastProbe = null
}

/** 探针图：512×384 的浅底上一个深色圆，框住它。 */
async function probeImage() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="384"><rect width="512" height="384" fill="#d9d4c7"/><circle cx="256" cy="192" r="90" fill="#3a4a6b"/></svg>`
  return (await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer()).toString('base64')
}

/**
 * 自建分割服务此刻的状态，部署后核对用：可达、模型是否已加载、内存。`probe` 时再真跑一张
 * 探针图量往返延迟（每 {@link PROBE_INTERVAL_MS} 至多一次，其余时候回上一次的结果）。
 * 不带任何用户数据，也不回分割服务的地址。
 */
export async function segmenterStatus(probe: boolean) {
  const { segmenterUrl, provider } = config.agent.segmentation
  if (!segmenterUrl || provider === 'off') return { configured: false as const }
  const origin = segmenterUrl.replace(/\/+$/, '')
  const fetchImpl = segmenterFetchOverride ?? fetch
  const startedAt = Date.now()
  const health = await fetchImpl(`${origin}/health`, { signal: AbortSignal.timeout(2_000) })
    .then(async (response) =>
      response.ok ? ((await response.json()) as Record<string, unknown>) : null,
    )
    .catch(() => null)
  const status = {
    configured: true as const,
    ok: Boolean(health?.ok),
    healthMs: Date.now() - startedAt,
    ...(health
      ? {
          loaded: health.loaded,
          dtype: health.dtype,
          threads: health.threads,
          cached: health.cached,
          rssMB: health.rssMB,
          version: health.version,
        }
      : {}),
  }
  if (!probe || !health?.ok) return status
  if (lastProbe && Date.now() - lastProbe.at < PROBE_INTERVAL_MS)
    return { ...status, probe: lastProbe.result }
  lastProbe = { at: Date.now(), result: { firstMs: -1, clickMs: -1, at: Date.now() } }
  const key = `probe:${++probeSequence}`
  const body = { key, box: [0.3, 0.2, 0.7, 0.8], output: { width: 512, height: 384 } }
  const call = async (extra: Record<string, unknown>) => {
    const begun = Date.now()
    const response = await fetchImpl(`${origin}/v1/segment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, ...extra }),
      signal: AbortSignal.timeout(SEGMENTER_TIMEOUT_MS * 4),
    })
    const parsed = (await response.json().catch(() => null)) as { timings?: unknown } | null
    if (!response.ok) throw new SegmentationError(`segmenter HTTP ${response.status}`)
    return { ms: Date.now() - begun, timings: parsed?.timings }
  }
  try {
    const first = await call({ image: await probeImage(), points: [[0.5, 0.5, 1]] })
    const click = await call({
      points: [
        [0.5, 0.5, 1],
        [0.1, 0.1, 0],
      ],
    })
    const result = {
      firstMs: first.ms,
      clickMs: click.ms,
      server: { first: first.timings, click: click.timings },
      at: Date.now(),
    }
    lastProbe = { at: lastProbe.at, result }
    return { ...status, probe: result }
  } catch (error) {
    return { ...status, probe: { error: error instanceof Error ? error.message : 'failed' } }
  }
}
