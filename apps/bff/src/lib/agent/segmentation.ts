import type { AgentMaskPromptPoint, AgentNormalizedBox } from '@image-playground/shared'
import sharp from 'sharp'
import { config } from '../../config'
import { log } from '../logger'
import { labelComponents } from './mask-regions'

/**
 * 修改范围提议与卡片点选的服务端分割。接口只有这一层：换模型只换实现，提议工具与卡片不跟着改。
 * 目前唯一的实现是自建 EdgeTAM（deploy/segmenter），用户原图不出本机；没有配置时返回 null，
 * 卡片按智能体给的框兜底。
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

interface SegmentationProvider {
  readonly id: string
  segment(request: SegmentationRequest): Promise<readonly SegmentationMask[]>
}

class SegmentationError extends Error {}

let providerOverride: SegmentationProvider | null | undefined
let segmenterFetchOverride: typeof fetch | undefined

export function setSegmentationProviderForTesting(provider?: SegmentationProvider | null): void {
  providerOverride = provider
}

export function setSegmenterFetchForTesting(fetchImpl?: typeof fetch): void {
  segmenterFetchOverride = fetchImpl
}

/**
 * 此刻可用的服务端分割：部署注入了自建 EdgeTAM 服务地址就用它；显式 `off` 或没有地址时为 null。
 * 不接任何第三方分割服务。
 */
export function segmentationProvider(): SegmentationProvider | null {
  if (providerOverride !== undefined) return providerOverride
  const { provider, segmenterUrl } = config.agent.segmentation
  if (provider === 'off' || !segmenterUrl) return null
  return edgeTam(segmenterUrl)
}

async function requestDataUrl(request: SegmentationRequest): Promise<string> {
  const dataUrl = request.dataUrl ?? (await request.loadDataUrl?.())
  if (!dataUrl) throw new SegmentationError('source image unavailable')
  return dataUrl
}

/**
 * 分割服务按这个键缓存图像编码。生产那一份由 internal 与 paid 共用，所以带上本部署的命名空间：
 * 测试环境的请求永远拿不到生产环境的缓存。
 */
export function segmenterKey(mediaId: string): string {
  const namespace = config.agent.segmentation.segmenterNamespace
  return namespace ? `${namespace}:media:${mediaId}` : `media:${mediaId}`
}

/** 自建服务的单次预算：卡片打开、点一下都要等它，超时就退回智能体给的框。 */
const SEGMENTER_TIMEOUT_MS = 3_000
/** 发给自建服务的图与它交回的蒙版的最长边；放大回原图在 BFF 做。 */
const SEGMENTER_MAX_SIDE = 1024
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

function segmenterMasks(body: unknown, width: number, height: number): SegmentationMask[] {
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
            // 分割服务按它给每个部署限额，一个环境占不满所有环境共用的队列。
            namespace: config.agent.segmentation.segmenterNamespace,
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

/** 框在蒙版像素坐标里的整数范围（左上含、右下不含）。 */
function pixelBox(box: AgentNormalizedBox, width: number, height: number) {
  const x0 = Math.max(0, Math.min(width, Math.round(box.x * width)))
  const y0 = Math.max(0, Math.min(height, Math.round(box.y * height)))
  const x1 = Math.max(x0, Math.min(width, Math.round((box.x + box.width) * width)))
  const y1 = Math.max(y0, Math.min(height, Math.round((box.y + box.height) * height)))
  return { x0, y0, x1, y1 }
}

/**
 * 去掉候选蒙版里与主体不相连的零碎块（8 邻接）。留下：最大的那块；含正向提示点的块；
 * 面积不小于最大块一半、且大半落在框内的块（被遮挡断开的同一对象）。其余小岛都去掉，
 * 例如分割服务顺带圈进来的挂画一角、窗帘一片。
 */
export function dropStrayFragments(
  mask: SegmentationMask,
  box: AgentNormalizedBox,
  points?: readonly AgentMaskPromptPoint[],
): SegmentationMask {
  const { width, height } = mask
  const parts = labelComponents(mask.data, true, width, height, true)
  const count = parts.areas.length - 1
  if (count <= 1) return mask
  const { x0, y0, x1, y1 } = pixelBox(box, width, height)
  const inBox = new Float64Array(count + 1)
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const label = parts.labels[y * width + x]!
      if (label) inBox[label]!++
    }
  let largest = 0
  for (let label = 1; label <= count; label++)
    if (parts.areas[label]! > (parts.areas[largest] ?? 0)) largest = label
  const keep = new Uint8Array(count + 1)
  keep[largest] = 1
  for (const point of points ?? []) {
    if (!point.include) continue
    const px = Math.min(width - 1, Math.max(0, Math.floor(point.x * width)))
    const py = Math.min(height - 1, Math.max(0, Math.floor(point.y * height)))
    const label = parts.labels[py * width + px]!
    if (label) keep[label] = 1
  }
  const big = parts.areas[largest]!
  for (let label = 1; label <= count; label++) {
    const area = parts.areas[label]!
    if (area >= big * FRAGMENT_KEEP_RATIO && inBox[label]! >= area * 0.5) keep[label] = 1
  }
  const data = new Uint8Array(mask.data.length)
  for (let i = 0; i < data.length; i++) if (keep[parts.labels[i]!]) data[i] = 255
  return { ...mask, data }
}

/** 与最大块不相连的部分至少要有它这么大（比例）才算同一对象被遮挡断开，否则当零碎去掉。 */
export const FRAGMENT_KEEP_RATIO = 0.5

/**
 * 蒙版与模型给的框按像素比：`inside` 是蒙版落在框内的比例（圈出框外的东西就低），
 * `coverage` 是蒙版占框面积的比例（只圈了对象一小块就低）。不再用外接框交并比：
 * 一张散成几片（挂画一角加窗帘一片）的错蒙版，外接框反而可能与框对得很齐。
 */
export function boxOverlap(mask: SegmentationMask, box: AgentNormalizedBox) {
  const { x0, y0, x1, y1 } = pixelBox(box, mask.width, mask.height)
  let area = 0
  let inside = 0
  for (let y = 0; y < mask.height; y++) {
    const row = y * mask.width
    for (let x = 0; x < mask.width; x++) {
      if (!mask.data[row + x]) continue
      area++
      if (x >= x0 && x < x1 && y >= y0 && y < y1) inside++
    }
  }
  const boxArea = (x1 - x0) * (y1 - y0)
  return {
    inside: area ? inside / area : 0,
    coverage: boxArea ? inside / boxArea : 0,
  }
}

/** 蒙版至少这么大比例落在框内，否则当分割认错了对象。 */
export const MIN_MASK_INSIDE_BOX = 0.5

/**
 * 与框的一致度：框内比例 × 覆盖率的平方根。开平方让细长对象（灯杆、在宽框里的人）不至于
 * 因为占框比例小就输给更小的局部，同时整件对象仍比只圈一块的候选得分高。
 */
export function boxAgreement(mask: SegmentationMask, box: AgentNormalizedBox): number {
  const { inside, coverage } = boxOverlap(mask, box)
  return inside < MIN_MASK_INSIDE_BOX ? 0 : inside * Math.sqrt(coverage)
}

/**
 * 每张候选先去掉零碎块，再按「置信度 × 与框的像素一致度」取最高的一张（交回的就是去碎后的
 * 那张）；大半落在框外的候选不参选，都不行时返回 null（调用方按框兜底）。
 */
export function pickMask(
  masks: readonly SegmentationMask[],
  box: AgentNormalizedBox,
  points?: readonly AgentMaskPromptPoint[],
): SegmentationMask | null {
  let best: SegmentationMask | null = null
  let bestValue = 0
  for (const candidate of masks) {
    const mask = dropStrayFragments(candidate, box, points)
    const agreement = boxAgreement(mask, box)
    if (!agreement) continue
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

/** 二值图的方形内收：对补集外扩再取补。图片边缘之外不算空白，贴边的蒙版不会被啃掉。 */
function erodeMask(source: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return source.slice()
  const inverse = new Uint8Array(source.length)
  for (let i = 0; i < source.length; i++) inverse[i] = source[i] ? 0 : 255
  const grown = dilateMask(inverse, width, height, radius)
  for (let i = 0; i < grown.length; i++) grown[i] = grown[i] ? 0 : 255
  return grown
}

/** 清理半径：约每 160px 长边 1px，3–12px。闭运算补上窄于两倍半径的缺口。 */
function cleanupRadius(width: number, height: number): number {
  return Math.min(12, Math.max(3, Math.round(Math.max(width, height) / 160)))
}

/** 方框均值后取半：把放大后的台阶边磨成顺滑的曲线，不改变大块形状。窗口在图边按实有像素算。 */
function smoothMask(source: Uint8Array, width: number, height: number, radius: number) {
  const rows = new Float32Array(source.length)
  const prefix = new Float64Array(width + 1)
  for (let y = 0; y < height; y++) {
    const base = y * width
    for (let x = 0; x < width; x++) prefix[x + 1] = prefix[x]! + (source[base + x] ? 1 : 0)
    for (let x = 0; x < width; x++) {
      const lo = x - radius < 0 ? 0 : x - radius
      const hi = x + radius + 1 > width ? width : x + radius + 1
      rows[base + x] = (prefix[hi]! - prefix[lo]!) / (hi - lo)
    }
  }
  // 竖向按行推进一个滑动窗口，逐行顺序读写，对缓存友好。
  const out = new Uint8Array(source.length)
  const column = new Float32Array(width)
  for (let y = 0; y < Math.min(height, radius); y++)
    for (let x = 0; x < width; x++) column[x]! += rows[y * width + x]!
  for (let y = 0; y < height; y++) {
    const enter = y + radius
    if (enter < height) for (let x = 0; x < width; x++) column[x]! += rows[enter * width + x]!
    const leave = y - radius - 1
    if (leave >= 0) for (let x = 0; x < width; x++) column[x]! -= rows[leave * width + x]!
    const count = Math.min(height, y + radius + 1) - Math.max(0, y - radius)
    const base = y * width
    for (let x = 0; x < width; x++) out[base + x] = column[x]! / count >= 0.5 ? 255 : 0
  }
  return out
}

/**
 * 分割结果的清理，在外扩之前做：
 * 1. 闭运算：把对象内部、边上窄于两倍半径的缺口补上（大衣下摆那种一格一格的锯齿块）；
 * 2. 填洞：不碰边、面积很小的空洞填满（杯把手围出的那种大空洞保留）；
 * 3. 去碎块：远小于主体、也只占画面一点点的孤立小块去掉；
 * 4. 磨边：台阶状的边界磨顺。
 * 清理后什么都不剩（不该发生）就原样返回，绝不把用户的选择清空。
 */
export function cleanMask(source: Uint8Array, width: number, height: number): Uint8Array {
  const radius = cleanupRadius(width, height)
  const total = width * height
  let mask = erodeMask(dilateMask(source, width, height, radius), width, height, radius)
  let area = 0
  for (const value of mask) if (value) area++
  if (!area) return source.slice()

  const holes = labelComponents(mask, false, width, height, false)
  const holeMax = Math.max(64, Math.min(total * 0.0015, area * 0.05))
  for (let i = 0; i < total; i++) {
    const label = holes.labels[i]!
    if (label && !holes.touchesBorder[label] && holes.areas[label]! <= holeMax) mask[i] = 255
  }

  const parts = labelComponents(mask, true, width, height, true)
  // 连通块可能上万个（噪声蒙版），不能把它们全摊成 Math.max 的参数。
  let largest = 0
  for (const partArea of parts.areas) if (partArea > largest) largest = partArea
  const islandMax = Math.min(largest * 0.1, total * 0.002)
  for (let i = 0; i < total; i++) {
    const label = parts.labels[i]!
    if (label && parts.areas[label]! < islandMax) mask[i] = 0
  }

  mask = smoothMask(mask, width, height, Math.max(1, Math.round(radius / 2)))
  return mask.some((value) => value) ? mask : source.slice()
}

/** 选中的蒙版放大回原图尺寸（平滑放大后取阈值，边缘不起锯齿），清理后再外扩。 */
export async function shapeMask(
  mask: SegmentationMask,
  width: number,
  height: number,
  radius = dilationRadius(width, height),
): Promise<SegmentationMask> {
  // 清理在分割服务交回的分辨率上做（长边 ≤1024），比在原图尺寸上做快几倍。
  const cleaned = new Uint8Array(mask.width * mask.height)
  for (let i = 0; i < cleaned.length; i++) cleaned[i] = mask.data[i]! >= 128 ? 255 : 0
  const source = cleanMask(cleaned, mask.width, mask.height)
  let binary: Uint8Array
  if (mask.width === width && mask.height === height) {
    binary = source
  } else {
    // sharp 对单通道 raw 也可能交回三通道，按 info.channels 取第一个通道。
    const { data, info } = await sharp(Buffer.from(source), {
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
 * 跑一次服务端分割：三张候选各自去掉零碎块后，按「置信度 × 与框的像素一致度」取一张，放大回原图并外扩。
 * 任何失败都只记一笔并返回 null，调用方按框兜底。
 */
export async function segmentProposal(request: SegmentationRequest) {
  const provider = segmentationProvider()
  if (!provider) return null
  const startedAt = Date.now()
  try {
    const masks = await provider.segment(request)
    const segmentedMs = Date.now() - startedAt
    const chosen = pickMask(masks, request.box, request.points)
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

interface SegmenterProbe {
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
  // 固定一个键：分割服务的编码缓存只有几格，每次换新键会把真实用户的图挤出去。
  const namespace = config.agent.segmentation.segmenterNamespace
  const key = namespace ? `${namespace}:probe` : 'probe'
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
