import type {
  AgentMarkedRegion,
  AgentMaskPromptPoint,
  AgentMaskProposal,
  AgentNormalizedBox,
  AgentTurnReference,
} from '@image-playground/shared'
import { AGENT_REGION_NOTE_MAX_CHARS } from '@image-playground/shared'
import type { MaskPlacement, MaskStroke } from '../../canvas/lib/inpaintMask'

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

/**
 * 反选时往主体边缘里收多少像素：服务端分割外扩的那一圈（4–8px，随长边增长）再加约 12px
 * （8–16px），让发梢、肩线这一圈落进重绘区，由模型对着新背景重画，而不是留一道旧背景的边。
 */
export function invertInset(width: number, height: number): number {
  const long = Math.max(width, height)
  return (
    Math.min(8, Math.max(4, Math.round(long / 256))) +
    Math.min(16, Math.max(8, Math.round(long / 128)))
  )
}

/** 反选：主体以外的全部都要改，并往主体里吃进 `inset` 像素。 */
export function invertMask(mask: TargetMask, inset: number): TargetMask {
  const outside = new Uint8Array(mask.data.length)
  for (let index = 0; index < outside.length; index++) outside[index] = mask.data[index] ? 0 : 1
  return dilateMask({ data: outside, width: mask.width, height: mask.height }, inset)
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

interface MaskAnswerText {
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
  /** 用户在所有区域之外点出来的新块：服务端只按它自己的点分割，不借提议的框和种子点。 */
  readonly added?: true
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

/** 新的一下离之前某一下这么近，就当作改主意：换掉旧的，不让一正一负叠在同一处。 */
const CLICK_REPLACE_DISTANCE = 0.03

/** 在一个区域的点选记录上加一下：附近的旧点让位，最多保留 `max` 个。 */
export function addClick(
  clicks: readonly AgentMaskPromptPoint[],
  click: AgentMaskPromptPoint,
  max: number,
): AgentMaskPromptPoint[] {
  return [
    ...clicks.filter(
      (one) => Math.hypot(one.x - click.x, one.y - click.y) > CLICK_REPLACE_DISTANCE,
    ),
    click,
  ].slice(-max)
}

/**
 * 点一下落在哪个区域上：点在谁的蒙版里就是谁（当前区域优先）。包含点落在所有蒙版之外时
 * 返回 `'added'`：另加一块包住点到的对象，原来的区域原样保留——不再把点并进某个区域、
 * 撑大它的框重新分割（那样常把原来的对象换掉，例如点了旁边的挂画、椅子就没了）。
 * 排除点只认已经包含它的那个区域，都不在就交给当前区域。
 */
export function regionForClick(
  containing: readonly number[],
  include: boolean,
  active: number,
): number | 'added' {
  if (containing.length) return containing.includes(active) ? active : containing[0]!
  return include ? 'added' : active
}

/** 新加的一块：编号接在已有区域后面，先用点周围的小框占位，分割回来后换成蒙版的外接框。 */
export function addedRegion(regions: readonly MaskRegionView[], point: Point): MaskRegionView {
  const number = Math.max(0, ...regions.map((one) => one.number)) + 1
  const side = 0.02
  return {
    number,
    box: {
      x: Math.max(0, Math.min(1 - side, point.x - side / 2)),
      y: Math.max(0, Math.min(1 - side, point.y - side / 2)),
      width: side,
      height: side,
    },
    selected: true,
    added: true,
  }
}

/** 点选重新分割时发给服务端的请求：新加的块只带它自己的点；提议里有多个区域时带区域编号。 */
export function refineRequest(
  region: Pick<MaskRegionView, 'number' | 'added'>,
  numbered: boolean,
  points: readonly AgentMaskPromptPoint[],
): { region?: number; area?: 'added'; points: readonly AgentMaskPromptPoint[] } {
  if (region.added) return { area: 'added', points }
  return { ...(numbered ? { region: region.number } : {}), points }
}

/**
 * 读提议里存好的区域蒙版：取地址或解码任一步失败都交回 null，由调用方按框兜底，
 * 不让一张蒙版读不到就把整张卡片标成失败。
 */
export async function storedRegionMask<T>(
  maskMediaId: string,
  resolve: (source: string) => Promise<string> | string,
  load: (source: string) => Promise<T>,
): Promise<T | null> {
  try {
    return await load(await resolve(`aip-media:${maskMediaId}`))
  } catch {
    return null
  }
}

/** 蒙版的外接框（归一化）；空蒙版为 null。 */
export function targetBounds(mask: TargetMask): AgentNormalizedBox | null {
  let x0 = mask.width
  let y0 = mask.height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < mask.height; y++)
    for (let x = 0; x < mask.width; x++) {
      if (!mask.data[y * mask.width + x]) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  if (x1 < 0) return null
  return {
    x: x0 / mask.width,
    y: y0 / mask.height,
    width: (x1 + 1 - x0) / mask.width,
    height: (y1 + 1 - y0) / mask.height,
  }
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

/**
 * 卡片上的涂抹沿用画布的笔画格式与光栅化（`paintMaskStroke`）：笔画按原图像素记，
 * 摆放就是原图本身，所以缩放预览、导出原图尺寸蒙版都不需要再换算。
 */
export function cardMaskPlacement(width: number, height: number): MaskPlacement {
  return { x: 0, y: 0, width, height, rotation: 0 }
}

/**
 * 一段画笔 / 橡皮：`from`、`to` 是相对坐标（0–1），`brush` 是屏幕上的笔刷直径，
 * `displayed` 是预览图在屏幕上的宽度。屏幕上看到多粗，原图上就涂多粗。
 */
export function cardMaskStroke(
  tool: 'brush' | 'eraser',
  points: readonly Point[],
  brush: number,
  displayed: number,
  width: number,
  height: number,
): MaskStroke {
  return {
    tool,
    points: points.map((point) => ({ x: point.x * width, y: point.y * height })),
    width: Math.max(2, (brush * width) / Math.max(1, displayed)),
  }
}
