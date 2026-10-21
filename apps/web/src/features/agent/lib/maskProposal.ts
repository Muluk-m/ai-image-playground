import type {
  AgentMarkedRegion,
  AgentMaskPromptPoint,
  AgentMaskProposal,
  AgentNormalizedBox,
  AgentTurnReference,
} from '@image-playground/shared'
import { AGENT_REGION_NOTE_MAX_CHARS } from '@image-playground/shared'

/** 边缘外扩：生成模型在蒙版边上会留一道接缝，往外多给几个像素让它有地方融合。 */
export const MASK_EDGE_EXPAND_PX = 4
/** 分割结果与智能体给的外接框至少要重合到这个程度，否则当它圈错了对象，退回粗略范围。 */
export const MIN_BOX_AGREEMENT = 0.3
/** 分割结果允许超出外接框的余量（按图片短边算），超出部分裁掉。 */
const BOX_MARGIN = 0.03

/** 用户在卡片上加的标注。只进定位图与文字，不进原图像素。 */
export type MaskAnnotation =
  | {
      readonly id: number
      readonly kind: 'arrow'
      readonly from: Point
      readonly to: Point
      readonly note: string
    }
  | { readonly id: number; readonly kind: 'note'; readonly at: Point; readonly note: string }

export interface Point {
  readonly x: number
  readonly y: number
}

/** 一张二值蒙版：1 = 要改的像素。 */
export interface TargetMask {
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
}

export function boxMask(width: number, height: number, box: AgentNormalizedBox): TargetMask {
  const data = new Uint8Array(width * height)
  // 浮点误差（0.2 + 0.4 = 0.6000000000000001）不能多吃一行。
  const left = Math.max(0, Math.floor(box.x * width + 1e-6))
  const top = Math.max(0, Math.floor(box.y * height + 1e-6))
  const right = Math.min(width, Math.ceil((box.x + box.width) * width - 1e-6))
  const bottom = Math.min(height, Math.ceil((box.y + box.height) * height - 1e-6))
  for (let y = top; y < bottom; y++) data.fill(1, y * width + left, y * width + right)
  return { data, width, height }
}

export function maskBounds(mask: TargetMask): AgentNormalizedBox | null {
  let left = mask.width
  let top = mask.height
  let right = -1
  let bottom = -1
  for (let y = 0; y < mask.height; y++) {
    const row = y * mask.width
    for (let x = 0; x < mask.width; x++) {
      if (!mask.data[row + x]) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  if (right < 0) return null
  return {
    x: left / mask.width,
    y: top / mask.height,
    width: (right - left + 1) / mask.width,
    height: (bottom - top + 1) / mask.height,
  }
}

export function boxIoU(a: AgentNormalizedBox, b: AgentNormalizedBox): number {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  const overlap = Math.max(0, right - left) * Math.max(0, bottom - top)
  const union = a.width * a.height + b.width * b.height - overlap
  return union > 0 ? overlap / union : 0
}

/**
 * SlimSAM 的解码器只认点，不认框：框换成框心一个正点（智能体给了正点就用它的），
 * 负点照搬。坐标按分割输入的像素尺寸给。
 */
export function promptPoints(
  box: AgentNormalizedBox,
  points: readonly AgentMaskPromptPoint[] | undefined,
  width: number,
  height: number,
): { points: [number, number][]; labels: number[] } {
  const given = points ?? []
  const positive = given.filter((point) => point.include)
  const chosen = positive.length
    ? given
    : [{ x: box.x + box.width / 2, y: box.y + box.height / 2, include: true }, ...given]
  return {
    points: chosen.map((point) => [point.x * width, point.y * height]),
    labels: chosen.map((point) => (point.include ? 1 : 0)),
  }
}

/**
 * 多个候选蒙版里挑一个：分数 × 与外接框的重合度。重合度太低说明圈到了别的东西，返回 null，
 * 让卡片退回粗略范围，而不是拿一块错位的蒙版去生成。
 */
export function pickSegmentMask(
  candidates: readonly TargetMask[],
  scores: readonly number[],
  box: AgentNormalizedBox,
): TargetMask | null {
  let best: TargetMask | null = null
  let bestValue = 0
  candidates.forEach((candidate, index) => {
    const bounds = maskBounds(candidate)
    if (!bounds) return
    const agreement = boxIoU(bounds, box)
    if (agreement < MIN_BOX_AGREEMENT) return
    const value = (scores[index] ?? 0.5) * agreement
    if (value > bestValue) {
      bestValue = value
      best = candidate
    }
  })
  return best ? clipToBox(best, box) : null
}

/** 超出外接框（加一点余量）的部分裁掉：分割模型偶尔会把相邻的同色物件一起带上。 */
export function clipToBox(mask: TargetMask, box: AgentNormalizedBox): TargetMask {
  const margin = BOX_MARGIN * Math.min(1, mask.width / mask.height, mask.height / mask.width)
  const left = Math.max(0, Math.floor((box.x - margin) * mask.width))
  const top = Math.max(0, Math.floor((box.y - margin) * mask.height))
  const right = Math.min(mask.width, Math.ceil((box.x + box.width + margin) * mask.width))
  const bottom = Math.min(mask.height, Math.ceil((box.y + box.height + margin) * mask.height))
  const data = new Uint8Array(mask.data.length)
  for (let y = top; y < bottom; y++)
    for (let x = left; x < right; x++) data[y * mask.width + x] = mask.data[y * mask.width + x]!
  return { ...mask, data }
}

/** 最近邻缩放：分割在小图上做，蒙版要回到原图尺寸。 */
export function resizeMask(mask: TargetMask, width: number, height: number): TargetMask {
  if (mask.width === width && mask.height === height) return mask
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const sourceRow = Math.min(mask.height - 1, Math.floor(((y + 0.5) * mask.height) / height))
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(mask.width - 1, Math.floor(((x + 0.5) * mask.width) / width))
      data[y * width + x] = mask.data[sourceRow * mask.width + sourceX]!
    }
  }
  return { data, width, height }
}

/** 圆形结构元素的膨胀；半径按原图像素算。逐行扫描，原图尺寸上也只是几百毫秒。 */
export function dilateMask(mask: TargetMask, radius: number): TargetMask {
  if (radius <= 0) return mask
  const { width, height } = mask
  const offsets: number[] = []
  for (let dy = -radius; dy <= radius; dy++)
    offsets.push(Math.floor(Math.sqrt(radius * radius - dy * dy)))
  // 先按行求「左右 r 以内有没有目标」的距离表，再按圆的每一行查。
  const nearest = new Int32Array(width * height).fill(radius + 1)
  for (let y = 0; y < height; y++) {
    const row = y * width
    let last = -Infinity
    for (let x = 0; x < width; x++) {
      if (mask.data[row + x]) last = x
      nearest[row + x] = Math.min(radius + 1, x - last)
    }
    last = Infinity
    for (let x = width - 1; x >= 0; x--) {
      if (mask.data[row + x]) last = x
      nearest[row + x] = Math.min(nearest[row + x]!, last - x)
    }
  }
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const sourceY = y + dy
        if (sourceY < 0 || sourceY >= height) continue
        if (nearest[sourceY * width + x]! <= offsets[dy + radius]!) {
          data[y * width + x] = 1
          break
        }
      }
    }
  return { data, width, height }
}

export function maskArea(mask: TargetMask): number {
  let count = 0
  for (const value of mask.data) if (value) count++
  return count
}

/** 上游与合成共用的格式：同尺寸 RGBA，不透明白色保留、透明重绘。 */
export function editMaskRgba(mask: TargetMask): Uint8ClampedArray<ArrayBuffer> {
  const rgba = new Uint8ClampedArray(new ArrayBuffer(mask.width * mask.height * 4)).fill(255)
  for (let index = 0; index < mask.data.length; index++)
    if (mask.data[index]) rgba[index * 4 + 3] = 0
  return rgba
}

/** 反过来：从上游格式（透明 = 重绘）读出二值蒙版。 */
export function targetFromEditMask(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
): TargetMask {
  const data = new Uint8Array(width * height)
  for (let index = 0; index < data.length; index++) data[index] = rgba[index * 4 + 3]! < 128 ? 1 : 0
  return { data, width, height }
}

const ANNOTATION_BOX = 0.04

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** 标注 → 编号区域：区域是标注落点周围一个小方块，箭头的尾端单独带上。 */
export function annotationRegions(annotations: readonly MaskAnnotation[]): AgentMarkedRegion[] {
  return annotations.flatMap((annotation, index) => {
    const note = annotation.note.trim().slice(0, AGENT_REGION_NOTE_MAX_CHARS)
    const at = annotation.kind === 'arrow' ? annotation.to : annotation.at
    const x = clamp(at.x - ANNOTATION_BOX / 2)
    const y = clamp(at.y - ANNOTATION_BOX / 2)
    const width = Math.min(ANNOTATION_BOX, 1 - x)
    const height = Math.min(ANNOTATION_BOX, 1 - y)
    if (width <= 0 || height <= 0) return []
    return [
      {
        number: index + 1,
        x,
        y,
        width,
        height,
        ...(note ? { note } : {}),
        ...(annotation.kind === 'arrow'
          ? { arrow: { x: clamp(annotation.from.x), y: clamp(annotation.from.y) } }
          : {}),
      },
    ]
  })
}

export interface MaskAnswerText {
  readonly confirmed: string
  readonly keep: string
  readonly annotation: string
  readonly arrow: string
}

/** 确认那条消息的正文：范围、要改成什么、不动什么、每条标注。卡片与历史都读这一句。 */
export function maskAnswerText(
  proposal: Pick<AgentMaskProposal, 'target' | 'change' | 'keep'>,
  annotations: readonly MaskAnnotation[],
  words: MaskAnswerText,
  extra = '',
): string {
  const lines = [`${words.confirmed}「${proposal.target}」：${proposal.change}`]
  if (proposal.keep.length) lines.push(`${words.keep}${proposal.keep.join('、')}`)
  annotations.forEach((annotation, index) => {
    const note = annotation.note.trim()
    if (!note) return
    lines.push(
      `${words.annotation} ${index + 1}${annotation.kind === 'arrow' ? `（${words.arrow}）` : ''}：${note}`,
    )
  })
  const added = extra.trim()
  if (added) lines.push(added)
  return lines.join('\n')
}

/** 带着蒙版回去的那条引用：原件按 id 引用（不重采样），蒙版与原图同尺寸。 */
export function maskAnswerReference(
  proposal: Pick<AgentMaskProposal, 'imageId' | 'mediaId'>,
  maskDataUrl: string,
  regions: readonly AgentMarkedRegion[],
  source = `aip-media:${proposal.mediaId}`,
): AgentTurnReference {
  return {
    imageId: proposal.imageId,
    dataUrl: source,
    maskDataUrl,
    ...(regions.length ? { regions } : {}),
    editAction: 'inpaint',
  }
}

/** 卡片上的一个可选区域：相似对象逐个编号；只有一个目标时就是提议本身。 */
export interface MaskRegionView {
  readonly number: number
  readonly label?: string
  readonly box: AgentNormalizedBox
  readonly selected: boolean
  readonly maskMediaId?: string
}

export function proposalRegions(
  proposal: Pick<AgentMaskProposal, 'box' | 'maskMediaId' | 'regions'>,
): MaskRegionView[] {
  if (proposal.regions?.length)
    return proposal.regions.map((one) => ({
      number: one.number,
      ...(one.label ? { label: one.label } : {}),
      box: one.box,
      selected: one.selected,
      ...(one.maskMediaId ? { maskMediaId: one.maskMediaId } : {}),
    }))
  return [
    {
      number: 1,
      box: proposal.box,
      selected: true,
      ...(proposal.maskMediaId ? { maskMediaId: proposal.maskMediaId } : {}),
    },
  ]
}

function inBox(box: AgentNormalizedBox, point: Point): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  )
}

/**
 * 点一下落在哪个区域上：先看点在谁的蒙版里，再看在谁的框里（多个就取面积最小的），
 * 都不是就交给当前区域。排除点只认已经包含它的那个区域。
 */
export function regionForClick(
  regions: readonly MaskRegionView[],
  containing: readonly number[],
  point: Point,
  include: boolean,
  active: number,
): number {
  if (containing.length) return containing.includes(active) ? active : containing[0]!
  if (!include) return active
  const boxed = regions
    .filter((one) => inBox(one.box, point))
    .sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height)
  return boxed[0]?.number ?? active
}

/** 确认后要出几张：默认 2；直接出图模式下输入框选了更多就按它（服务端同一口径）。 */
export const MASK_CONFIRMED_DEFAULT_COUNT = 2
export function maskOutputCount(composerCount: number | undefined): number {
  return Math.max(MASK_CONFIRMED_DEFAULT_COUNT, composerCount ?? 1)
}

/** 确认那条用户消息里带回来的蒙版：云端引用给 media id，内联引用给 data URL。 */
export function confirmedMaskSource(
  references: readonly unknown[] | undefined,
  proposal: Pick<AgentMaskProposal, 'imageId'>,
): string | null {
  for (const reference of references ?? []) {
    if (!reference || typeof reference !== 'object') continue
    const one = reference as { imageId?: unknown; maskMediaId?: unknown; maskDataUrl?: unknown }
    if (one.imageId !== proposal.imageId) continue
    if (typeof one.maskMediaId === 'string') return `aip-media:${one.maskMediaId}`
    if (typeof one.maskDataUrl === 'string') return one.maskDataUrl
  }
  return null
}
