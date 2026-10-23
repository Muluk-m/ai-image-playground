import type { AgentMaskPromptPoint, AgentMaskProposal } from '@image-playground/shared'
import { type PointerEvent, useCallback, useEffect, useRef, useState } from 'react'
import SegmentedTabs from '../../../components/patterns/SegmentedTabs'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Input } from '../../../components/ui/input'
import { Slider } from '../../../components/ui/slider'
import { useTranslation } from '../../../i18n'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import { fillMaskLasso, isUsableMaskLasso } from '../../../lib/mask'
import { useStore } from '../../../store'
import { exportMaskCanvasDataUrl, paintMaskStroke } from '../../canvas/lib/inpaintMask'
import { refineEditRegion } from '../lib/agentClient'
import { attachmentUploadsEnabled, mediaFallbackEnabled } from '../lib/attachmentUploads'
import {
  addClick,
  annotationRegions,
  cardMaskPlacement,
  cardMaskStroke,
  editMaskRgba,
  invertInset,
  invertMask,
  type MaskAnnotation,
  type MaskRegionView,
  maskAnswerReference,
  maskAnswerText,
  maskArea,
  maskOutputCount,
  type Point,
  proposalRegions,
  regionForClick,
  type TargetMask,
} from '../lib/maskProposal'
import { useAgentStore } from '../store'
import type { AgentClarificationMessage } from '../types'

type Tool = 'point' | 'brush' | 'eraser' | 'box' | 'lasso' | 'arrow' | 'text'
type Status = 'loading' | 'suggested' | 'rough' | 'failed'
/** 覆盖层的三种样子：AI 建议（白色虚线描边）、用户调整过（白色实线）、已确认（主色实线）。 */
type Look = 'suggested' | 'edited' | 'confirmed'
interface RegionState extends MaskRegionView {
  /** 用户在这个区域上点的包含 / 排除点，按顺序累积，每次整组发给分割服务。 */
  readonly clicks: readonly AgentMaskPromptPoint[]
}
type RegionPixels = { number: number; pixels: ImageData }
type Snapshot = {
  pixels: ImageData
  annotations: MaskAnnotation[]
  regions: RegionState[]
  inverted: boolean
  regionMasks?: RegionPixels[]
}

/** 覆盖层只画在缩小的预览上；导出的蒙版始终是原图尺寸。 */
const PREVIEW_EDGE = 1024
const HISTORY_BYTES = 32 * 1024 * 1024
const MAX_ANNOTATIONS = 12
const MAX_CLICKS = 12
/** 点选与画笔、橡皮是常用的修正工具；框、套索在「更多工具」里；箭头与文字只做说明。 */
const PAINT_TOOLS = [
  { tool: 'brush', icon: 'brush', label: 'maskProposal.toolBrush' },
  { tool: 'eraser', icon: 'erase', label: 'maskProposal.toolEraser' },
] as const satisfies readonly { tool: Tool; icon: string; label: string }[]
const SHAPE_TOOLS = [
  { tool: 'box', icon: 'selectRectangle', label: 'maskProposal.toolBox' },
  { tool: 'lasso', icon: 'selectLasso', label: 'maskProposal.toolLasso' },
] as const satisfies readonly { tool: Tool; icon: string; label: string }[]
const NOTE_TOOLS = [
  { tool: 'arrow', icon: 'drawArrow', label: 'maskProposal.toolArrow' },
  { tool: 'text', icon: 'text', label: 'maskProposal.toolText' },
] as const satisfies readonly { tool: Tool; icon: string; label: string }[]

function annotationColor(alpha = 1): string {
  const value =
    typeof document === 'undefined'
      ? ''
      : getComputedStyle(document.documentElement).getPropertyValue('--canvas-annotation').trim()
  return value ? `hsl(${value} / ${alpha})` : `rgba(21, 156, 246, ${alpha})`
}

function canvasOf(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  return canvas.getContext('2d', { willReadFrequently: true })!
}

function readTarget(canvas: HTMLCanvasElement): TargetMask {
  const { data } = context2d(canvas).getImageData(0, 0, canvas.width, canvas.height)
  const target = new Uint8Array(canvas.width * canvas.height)
  for (let index = 0; index < target.length; index++)
    target[index] = data[index * 4 + 3]! >= 128 ? 1 : 0
  return { data: target, width: canvas.width, height: canvas.height }
}

/** 二值蒙版 → 白色不透明 = 目标的画布。 */
function canvasFromTarget(mask: TargetMask): HTMLCanvasElement {
  const canvas = canvasOf(mask.width, mask.height)
  const rgba = new Uint8ClampedArray(new ArrayBuffer(mask.width * mask.height * 4))
  for (let index = 0; index < mask.data.length; index++)
    if (mask.data[index]) rgba.set([255, 255, 255, 255], index * 4)
  context2d(canvas).putImageData(new ImageData(rgba, mask.width, mask.height), 0, 0)
  return canvas
}

/** 画的时候用的粗略反选：直接取补集，不内收；松手后再按 {@link invertMask} 精确算。 */
function complementCanvas(mask: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = canvasOf(mask.width, mask.height)
  const context = canvas.getContext('2d')!
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.globalCompositeOperation = 'destination-out'
  context.drawImage(mask, 0, 0)
  return canvas
}

/**
 * 从总范围里去掉一个区域：只擦它的蒙版会连同与它重叠的、仍选中的区域一起擦掉，
 * 所以擦完把其他选中区域落在重叠处的那部分补回来（只补重叠处，别处的橡皮擦痕迹不动）。
 */
function removeRegionFromMask(
  mask: HTMLCanvasElement,
  removed: HTMLCanvasElement,
  stillSelected: readonly HTMLCanvasElement[],
) {
  const context = mask.getContext('2d')!
  context.save()
  context.globalCompositeOperation = 'destination-out'
  context.drawImage(removed, 0, 0)
  context.restore()
  if (!stillSelected.length) return
  const overlap = canvasOf(mask.width, mask.height)
  const overlapContext = overlap.getContext('2d')!
  for (const other of stillSelected) overlapContext.drawImage(other, 0, 0)
  overlapContext.globalCompositeOperation = 'destination-in'
  overlapContext.drawImage(removed, 0, 0)
  context.drawImage(overlap, 0, 0)
}

/** 确认时送回去的蒙版：与画布涂抹走同一个导出（空选区拦截、PNG 编码）。 */
async function maskDataUrl(mask: TargetMask): Promise<string> {
  const canvas = canvasOf(mask.width, mask.height)
  context2d(canvas).putImageData(new ImageData(editMaskRgba(mask), mask.width, mask.height), 0, 0)
  return await exportMaskCanvasDataUrl(canvas)
}

function pixelsOf(canvas: HTMLCanvasElement): ImageData {
  return context2d(canvas).getImageData(0, 0, canvas.width, canvas.height)
}

/** 编辑格式（透明 = 重绘）的蒙版图 → 白色不透明 = 目标的画布，按原图尺寸。 */
function targetCanvas(editMask: HTMLImageElement, width: number, height: number) {
  const canvas = canvasOf(width, height)
  const context = context2d(canvas)
  context.drawImage(editMask, 0, 0, width, height)
  const pixels = context.getImageData(0, 0, width, height)
  for (let index = 0; index < width * height; index++) {
    const target = pixels.data[index * 4 + 3]! < 128
    pixels.data.set(target ? [255, 255, 255, 255] : [0, 0, 0, 0], index * 4)
  }
  context.putImageData(pixels, 0, 0)
  return canvas
}

function boxCanvas(region: MaskRegionView, width: number, height: number) {
  const canvas = canvasOf(width, height)
  const context = context2d(canvas)
  context.fillStyle = '#fff'
  context.fillRect(
    region.box.x * width,
    region.box.y * height,
    region.box.width * width,
    region.box.height * height,
  )
  return canvas
}

function covers(canvas: HTMLCanvasElement | undefined, point: Point): boolean {
  if (!canvas) return false
  const x = Math.min(canvas.width - 1, Math.floor(point.x * canvas.width))
  const y = Math.min(canvas.height - 1, Math.floor(point.y * canvas.height))
  return context2d(canvas).getImageData(x, y, 1, 1).data[3]! >= 128
}

async function inlineOriginal(source: string): Promise<string> {
  const blob = await (await fetch(source)).blob()
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('image_load_failed'))
    image.src = source
  })
}

let stripes: HTMLCanvasElement | null = null
/** 斜纹：与描边求交，白色描边就成了一段一段的虚线——「还只是建议」。 */
function stripePattern(context: CanvasRenderingContext2D, scale: number) {
  const size = Math.max(8, Math.round(10 * scale))
  if (!stripes || stripes.width !== size) {
    stripes = canvasOf(size, size)
    const tile = stripes.getContext('2d')!
    tile.strokeStyle = '#fff'
    tile.lineWidth = size * 0.55
    for (const offset of [-size, 0, size]) {
      tile.beginPath()
      tile.moveTo(offset, size)
      tile.lineTo(offset + size, 0)
      tile.stroke()
    }
  }
  return context.createPattern(stripes, 'repeat')!
}

/**
 * 画范围覆盖层：范围外压暗，范围内半透明着色，再沿边描一圈。`mask` 白色不透明 = 目标，
 * 任意尺寸，按 `target` 的尺寸缩放。
 */
function paintOverlay(
  target: HTMLCanvasElement,
  mask: CanvasImageSource,
  look: Look,
  scale: number,
) {
  const { width, height } = target
  const context = target.getContext('2d')!
  context.clearRect(0, 0, width, height)
  context.save()
  context.fillStyle = 'rgba(0, 0, 0, 0.38)'
  context.fillRect(0, 0, width, height)
  context.globalCompositeOperation = 'destination-out'
  context.drawImage(mask, 0, 0, width, height)
  context.restore()

  const tint = canvasOf(width, height)
  const tintContext = tint.getContext('2d')!
  tintContext.drawImage(mask, 0, 0, width, height)
  tintContext.globalCompositeOperation = 'source-in'
  tintContext.fillStyle = annotationColor(look === 'confirmed' ? 0.42 : 0.32)
  tintContext.fillRect(0, 0, width, height)
  context.drawImage(tint, 0, 0)

  const ring = canvasOf(width, height)
  const ringContext = ring.getContext('2d')!
  const edge = Math.max(1.5, 2 * scale)
  for (let step = 0; step < 8; step++) {
    const angle = (step / 8) * Math.PI * 2
    ringContext.drawImage(mask, Math.cos(angle) * edge, Math.sin(angle) * edge, width, height)
  }
  ringContext.globalCompositeOperation = 'destination-out'
  ringContext.drawImage(mask, 0, 0, width, height)
  ringContext.globalCompositeOperation = 'source-in'
  ringContext.fillStyle = look === 'confirmed' ? annotationColor(1) : 'rgba(255, 255, 255, 0.95)'
  ringContext.fillRect(0, 0, width, height)
  if (look === 'suggested') {
    ringContext.globalCompositeOperation = 'destination-in'
    ringContext.fillStyle = stripePattern(ringContext, scale)
    ringContext.fillRect(0, 0, width, height)
  }
  context.drawImage(ring, 0, 0)
}

/** 已确认的范围：一张小缩略图，主色实线描边，旁边写明确认了什么。 */
function ConfirmedThumbnail({ proposal, mask }: { proposal: AgentMaskProposal; mask: string }) {
  const [source, setSource] = useState('')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const resolved = await resolveMediaSource(`aip-media:${proposal.mediaId}`, 'preview', true)
        const maskImage = await loadImage(
          mask.startsWith('aip-media:') ? await resolveMediaSource(mask, 'original', true) : mask,
        )
        if (!active) return
        setSource(resolved)
        const canvas = canvasRef.current
        if (!canvas) return
        const scale = Math.min(1, 480 / Math.max(proposal.width, proposal.height))
        canvas.width = Math.max(1, Math.round(proposal.width * scale))
        canvas.height = Math.max(1, Math.round(proposal.height * scale))
        paintOverlay(canvas, targetCanvas(maskImage, canvas.width, canvas.height), 'confirmed', 1)
      } catch {
        if (active) setSource('')
      }
    })()
    return () => {
      active = false
    }
  }, [mask, proposal])
  return (
    <div className="studio-mask-proposal-thumb" data-ready={source ? true : undefined}>
      {source && <img src={source} alt="" draggable={false} />}
      <canvas ref={canvasRef} aria-hidden="true" />
    </div>
  )
}

export function AnsweredMaskProposal({
  proposal,
  confirmed,
  mask,
}: {
  proposal: AgentMaskProposal
  confirmed: boolean
  /** 确认时带回去的蒙版（`aip-media:` 或 data URL）；读不到就只显示文字。 */
  mask?: string | null
}) {
  const { t } = useTranslation('agent')
  if (!confirmed)
    return (
      <div className="studio-clarification-answered studio-clarification-answered--unknown">
        <Icon name="check" size="sm" />
        <span>{t('maskProposal.answeredOther')}</span>
      </div>
    )
  return (
    <section
      className="studio-mask-proposal"
      data-look="confirmed"
      aria-label={t('maskProposal.title')}
    >
      <div className="studio-mask-proposal-confirmed">
        {mask && <ConfirmedThumbnail proposal={proposal} mask={mask} />}
        <div className="studio-mask-proposal-confirmed-text">
          <span className="studio-mask-proposal-state" data-look="confirmed">
            <Icon name="success" size="sm" />
            {t('maskProposal.stateConfirmed')}
          </span>
          <p>{t('maskProposal.answered', { target: proposal.target })}</p>
          <p className="studio-mask-proposal-muted">
            <Icon name="lock" size="sm" />
            {t('maskProposal.lock')}
          </p>
        </div>
      </div>
    </section>
  )
}

export default function AgentMaskProposalCard({
  message,
  proposal,
  answered,
}: {
  message: AgentClarificationMessage
  proposal: AgentMaskProposal
  answered: boolean
}) {
  const { t } = useTranslation('agent')
  const showToast = useStore((state) => state.showToast)
  const outputs = useStore((state) =>
    maskOutputCount(state.createTarget === 'generate' ? state.params.n : undefined),
  )
  const running = useAgentStore((state) => state.turn === 'running')
  const conversationId = useAgentStore((state) => state.conversationId)
  const imageRef = useRef<HTMLImageElement>(null)
  const maskRef = useRef<HTMLCanvasElement | null>(null)
  const regionMasksRef = useRef(new Map<number, HTMLCanvasElement>())
  const previewRef = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef<number | null>(null)
  const refineRef = useRef({ sequence: 0, controller: null as AbortController | null })
  const pointerRef = useRef<{
    id: number
    tool: Tool
    start: Point
    last: Point
    path: Point[]
    /** 落笔时预览图在屏幕上的宽度：笔刷按屏幕粗细换算到原图。 */
    displayed: number
    before?: ImageData
  } | null>(null)
  /** 卡片打开时的 AI 建议，「恢复 AI 建议」回到这里。 */
  const autoRef = useRef<{
    pixels: ImageData
    regionMasks: RegionPixels[]
    regions: RegionState[]
  } | null>(null)
  const undoRef = useRef<Snapshot[]>([])
  const redoRef = useRef<Snapshot[]>([])
  const nextAnnotationRef = useRef(1)
  const noteRefs = useRef(new Map<number, HTMLInputElement>())
  const [source, setSource] = useState('')
  const [status, setStatus] = useState<Status>('loading')
  const [touched, setTouched] = useState(false)
  const [refining, setRefining] = useState(false)
  const [editing, setEditing] = useState(false)
  const [tool, setTool] = useState<Tool>('point')
  const [pointMode, setPointMode] = useState<'include' | 'exclude'>('include')
  const [brush, setBrush] = useState(24)
  const [regions, setRegions] = useState<RegionState[]>(() =>
    proposalRegions(proposal).map((one) => ({ ...one, clicks: [] })),
  )
  const [active, setActive] = useState(
    () => proposalRegions(proposal).find((one) => one.selected)?.number ?? 1,
  )
  const [annotations, setAnnotations] = useState<MaskAnnotation[]>([])
  const [history, setHistory] = useState({ undo: false, redo: false })
  const [drawing, setDrawing] = useState(false)
  const [sketch, setSketch] = useState<Point[] | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [writing, setWriting] = useState(false)
  const [other, setOther] = useState('')
  // 反选：卡片上点选、画笔调整的始终是主体；显示与确认时取它以外的部分（往主体里收一圈）。
  const [inverted, setInverted] = useState(proposal.invert === true)
  const locked = answered || running || submitting
  const ready = status === 'suggested' || status === 'rough'
  const numbered = regions.length > 1
  const look: Look = touched ? 'edited' : 'suggested'

  const redrawNow = useCallback(() => {
    frameRef.current = null
    const mask = maskRef.current
    const preview = previewRef.current
    const context = preview?.getContext('2d')
    if (!mask || !preview || !context) return
    const scale = preview.width / Math.max(1, imageRef.current?.getBoundingClientRect().width ?? 1)
    const shown = !inverted
      ? mask
      : pointerRef.current
        ? complementCanvas(mask)
        : canvasFromTarget(invertMask(readTarget(mask), invertInset(mask.width, mask.height)))
    paintOverlay(preview, shown, look, scale)
    context.save()
    // 没选中的相似对象只画一个虚线框，点编号就能加进来。
    if (numbered) {
      context.setLineDash([6 * scale, 5 * scale])
      context.lineWidth = 1.5 * scale
      context.strokeStyle = 'rgba(255, 255, 255, 0.75)'
      for (const region of regions)
        if (!region.selected)
          context.strokeRect(
            region.box.x * preview.width,
            region.box.y * preview.height,
            region.box.width * preview.width,
            region.box.height * preview.height,
          )
      context.setLineDash([])
    }
    const strokes = [
      ...annotations.flatMap((annotation) =>
        annotation.kind === 'arrow' ? [[annotation.from, annotation.to] as const] : [],
      ),
      ...(sketch && pointerRef.current?.tool === 'arrow' && sketch.length === 2
        ? [[sketch[0]!, sketch[1]!] as const]
        : []),
    ]
    context.strokeStyle = context.fillStyle = annotationColor(1)
    context.lineWidth = 2.5 * scale
    context.lineCap = 'round'
    for (const [from, to] of strokes) {
      const fromX = from.x * preview.width
      const fromY = from.y * preview.height
      const toX = to.x * preview.width
      const toY = to.y * preview.height
      const angle = Math.atan2(toY - fromY, toX - fromX)
      const head = 10 * scale
      context.beginPath()
      context.moveTo(fromX, fromY)
      context.lineTo(toX - Math.cos(angle) * head * 0.8, toY - Math.sin(angle) * head * 0.8)
      context.stroke()
      context.beginPath()
      context.moveTo(toX, toY)
      context.lineTo(toX - Math.cos(angle - 0.45) * head, toY - Math.sin(angle - 0.45) * head)
      context.lineTo(toX - Math.cos(angle + 0.45) * head, toY - Math.sin(angle + 0.45) * head)
      context.closePath()
      context.fill()
    }
    if (sketch && sketch.length > 1 && pointerRef.current?.tool !== 'arrow') {
      context.beginPath()
      context.moveTo(sketch[0]!.x * preview.width, sketch[0]!.y * preview.height)
      for (const point of sketch.slice(1))
        context.lineTo(point.x * preview.width, point.y * preview.height)
      context.closePath()
      context.fillStyle = annotationColor(0.3)
      context.fill()
      context.strokeStyle = 'rgba(255, 255, 255, 0.9)'
      context.lineWidth = 1.5 * scale
      context.stroke()
    }
    context.restore()
  }, [annotations, inverted, look, numbered, regions, sketch])

  // 帧里总是跑最新的那版重绘：排帧之后样式（建议 → 已调整）变了，也按新的画。
  const redrawNowRef = useRef(redrawNow)
  redrawNowRef.current = redrawNow
  const redraw = useCallback(() => {
    if (frameRef.current === null)
      frameRef.current = requestAnimationFrame(() => redrawNowRef.current())
  }, [])

  useEffect(() => {
    redraw()
  }, [redraw, redrawNow])
  useEffect(
    () => () => {
      // 卸载（含开发模式的重复挂载）时取消并清空，否则后面的重绘永远排不上。
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      refineRef.current.controller?.abort()
    },
    [],
  )

  // 原图与建议蒙版：服务端分割好的区域直接用；分割没成功的区域先按智能体给的框画。
  // 浏览器内分割（segmentClient）不再参与：卡片打开时蒙版已经在服务端准备好了。
  useEffect(() => {
    if (answered) return
    let active = true
    void (async () => {
      try {
        const resolved = await resolveMediaSource(`aip-media:${proposal.mediaId}`, 'original', true)
        if (!active) return
        setSource(resolved)
        const image = await loadImage(resolved)
        if (!active) return
        const width = image.naturalWidth
        const height = image.naturalHeight
        const preview = previewRef.current
        if (preview) {
          const scale = Math.min(1, PREVIEW_EDGE / Math.max(width, height))
          preview.width = Math.max(1, Math.round(width * scale))
          preview.height = Math.max(1, Math.round(height * scale))
        }
        const views = proposalRegions(proposal)
        let rough = false
        const masks = new Map<number, HTMLCanvasElement>()
        for (const region of views) {
          if (region.maskMediaId) {
            const server = await loadImage(
              await resolveMediaSource(`aip-media:${region.maskMediaId}`, 'original', true),
            ).catch(() => null)
            if (server) {
              masks.set(region.number, targetCanvas(server, width, height))
              continue
            }
          }
          if (region.selected) rough = true
          masks.set(region.number, boxCanvas(region, width, height))
        }
        if (!active) return
        const mask = canvasOf(width, height)
        const context = mask.getContext('2d')!
        for (const region of views)
          if (region.selected) context.drawImage(masks.get(region.number)!, 0, 0)
        regionMasksRef.current = masks
        maskRef.current = mask
        autoRef.current = {
          pixels: pixelsOf(mask),
          regionMasks: [...masks].map(([number, canvas]) => ({ number, pixels: pixelsOf(canvas) })),
          regions: views.map((one) => ({ ...one, clicks: [] })),
        }
        setStatus(rough ? 'rough' : 'suggested')
        redraw()
      } catch {
        if (active) setStatus('failed')
      }
    })()
    return () => {
      active = false
    }
  }, [answered, proposal, redraw])

  const pointOnImage = (event: PointerEvent<HTMLElement>): Point | null => {
    const image = imageRef.current
    if (!image) return null
    const box = image.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
    }
  }

  const remember = (extra: Partial<Pick<Snapshot, 'pixels' | 'regionMasks'>> = {}) => {
    const mask = maskRef.current
    if (!mask) return
    undoRef.current.push({
      pixels: extra.pixels ?? pixelsOf(mask),
      annotations,
      regions,
      inverted,
      ...(extra.regionMasks ? { regionMasks: extra.regionMasks } : {}),
    })
    const limit = Math.max(
      1,
      Math.min(20, Math.floor(HISTORY_BYTES / (mask.width * mask.height * 4 * 2))),
    )
    while (undoRef.current.length > limit) undoRef.current.shift()
    redoRef.current = []
    setTouched(true)
    setHistory({ undo: true, redo: false })
  }

  const restore = (direction: 'undo' | 'redo') => {
    const mask = maskRef.current
    if (!mask || pointerRef.current || refining) return
    const from = direction === 'undo' ? undoRef.current : redoRef.current
    const to = direction === 'undo' ? redoRef.current : undoRef.current
    const previous = from.pop()
    if (!previous) return
    const regionCanvases = (previous.regionMasks ?? []).flatMap((one) => {
      const canvas = regionMasksRef.current.get(one.number)
      return canvas ? [{ ...one, canvas }] : []
    })
    to.push({
      pixels: pixelsOf(mask),
      annotations,
      regions,
      inverted,
      ...(regionCanvases.length
        ? {
            regionMasks: regionCanvases.map((one) => ({
              number: one.number,
              pixels: pixelsOf(one.canvas),
            })),
          }
        : {}),
    })
    context2d(mask).putImageData(previous.pixels, 0, 0)
    for (const one of regionCanvases) context2d(one.canvas).putImageData(one.pixels, 0, 0)
    setAnnotations(previous.annotations)
    setRegions(previous.regions)
    setInverted(previous.inverted)
    setTouched(true)
    setHistory({ undo: undoRef.current.length > 0, redo: redoRef.current.length > 0 })
    redraw()
  }

  /**
   * 画笔加进范围、橡皮擦出范围。光栅化用画布涂抹的 `paintMaskStroke`：这张画布白色不透明
   * = 要改，正是它「画出来的就是可重绘区」那种渲染语义。
   */
  const paint = (points: readonly Point[], tool: 'brush' | 'eraser', displayed: number) => {
    const mask = maskRef.current
    if (!mask) return
    const { width, height } = mask
    paintMaskStroke(
      context2d(mask),
      cardMaskPlacement(width, height),
      { width, height },
      cardMaskStroke(tool, points, brush, displayed, width, height),
      { inverted: true, color: '#fff' },
    )
    redraw()
  }

  /** 回到卡片打开时的 AI 建议：范围、点选、对象选择与反选都复原；可以撤销。 */
  const resetToAuto = () => {
    const mask = maskRef.current
    const auto = autoRef.current
    if (!mask || !auto || locked || refining || drawing) return
    remember({
      regionMasks: [...regionMasksRef.current].map(([number, canvas]) => ({
        number,
        pixels: pixelsOf(canvas),
      })),
    })
    context2d(mask).putImageData(auto.pixels, 0, 0)
    for (const one of auto.regionMasks) {
      const canvas = regionMasksRef.current.get(one.number)
      if (canvas) context2d(canvas).putImageData(one.pixels, 0, 0)
    }
    setRegions(auto.regions)
    setActive(auto.regions.find((one) => one.selected)?.number ?? 1)
    setInverted(proposal.invert === true)
    setTouched(false)
    redraw()
  }

  /** 除了这个区域以外仍选中的区域蒙版。 */
  const otherSelectedMasks = (number: number) =>
    regions.flatMap((one) => {
      const canvas = one.selected && one.number !== number && regionMasksRef.current.get(one.number)
      return canvas ? [canvas] : []
    })

  /** 把一个区域的新蒙版换进总范围：先去掉它旧的那份，选中时再放进新的。 */
  const swapRegionMask = (number: number, next: HTMLCanvasElement, selected: boolean) => {
    const mask = maskRef.current
    const current = regionMasksRef.current.get(number)
    if (!mask || !current) return
    const context = mask.getContext('2d')!
    removeRegionFromMask(mask, current, otherSelectedMasks(number))
    if (selected) context.drawImage(next, 0, 0)
    const keep = context2d(current)
    keep.clearRect(0, 0, current.width, current.height)
    keep.drawImage(next, 0, 0)
  }

  const toggleInverted = () => {
    if (!maskRef.current || locked || refining || drawing) return
    remember()
    setInverted((current) => !current)
  }

  const toggleRegion = (number: number) => {
    const mask = maskRef.current
    const regionMask = regionMasksRef.current.get(number)
    const region = regions.find((one) => one.number === number)
    if (!mask || !regionMask || !region || locked || refining) return
    remember()
    if (region.selected) removeRegionFromMask(mask, regionMask, otherSelectedMasks(number))
    else mask.getContext('2d')!.drawImage(regionMask, 0, 0)
    setRegions((current) =>
      current.map((one) => (one.number === number ? { ...one, selected: !one.selected } : one)),
    )
    if (!region.selected) setActive(number)
    redraw()
  }

  /** 点一下：在这个区域上叠加点，交给服务端重新分割；旧请求的结果晚到就丢掉。 */
  const click = async (point: Point, include: boolean) => {
    const mask = maskRef.current
    if (!mask || !conversationId) return
    const hits = regions
      .filter((one) => covers(regionMasksRef.current.get(one.number), point))
      .map((one) => one.number)
    const number = regionForClick(regions, hits, point, include, active)
    const region = regions.find((one) => one.number === number)
    if (!region) return
    const clicks = addClick(region.clicks, { x: point.x, y: point.y, include }, MAX_CLICKS)
    const selected = region.selected || include
    const regionCanvas = regionMasksRef.current.get(number)!
    remember({ regionMasks: [{ number, pixels: pixelsOf(regionCanvas) }] })
    const nextRegions = regions.map((one) =>
      one.number === number ? { ...one, clicks, selected } : one,
    )
    setRegions(nextRegions)
    setActive(number)
    refineRef.current.controller?.abort()
    const controller = new AbortController()
    const sequence = ++refineRef.current.sequence
    refineRef.current.controller = controller
    setRefining(true)
    try {
      const refined = await refineEditRegion(
        conversationId,
        proposal.id,
        { ...(proposal.regions?.length ? { region: number } : {}), points: clicks },
        controller.signal,
      )
      const image = await loadImage(refined.mask)
      if (sequence !== refineRef.current.sequence) return
      swapRegionMask(number, targetCanvas(image, mask.width, mask.height), selected)
      redraw()
    } catch {
      if (controller.signal.aborted || sequence !== refineRef.current.sequence) return
      // 点没生效：撤回这一步，改用画笔。
      undoRef.current.pop()
      setRegions(regions)
      setHistory({ undo: undoRef.current.length > 0, redo: redoRef.current.length > 0 })
      showToast(t('maskProposal.pointUnavailable'), 'error')
      setEditing(true)
      setTool('brush')
    } finally {
      if (sequence === refineRef.current.sequence) {
        refineRef.current.controller = null
        setRefining(false)
      }
    }
  }

  const addAnnotation = (annotation: MaskAnnotation) => {
    remember()
    setAnnotations((current) => [...current, annotation])
    requestAnimationFrame(() => noteRefs.current.get(annotation.id)?.focus())
  }

  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (locked || !ready || event.button !== 0 || pointerRef.current || !maskRef.current) return
    const point = pointOnImage(event)
    if (!point) return
    if (tool === 'point') {
      void click(point, (pointMode === 'include') !== event.altKey)
      return
    }
    if (tool === 'text') {
      if (annotations.length >= MAX_ANNOTATIONS) return
      addAnnotation({ id: nextAnnotationRef.current++, kind: 'note', at: point, note: '' })
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    const mask = maskRef.current
    const displayed = Math.max(1, imageRef.current!.getBoundingClientRect().width)
    pointerRef.current = {
      id: event.pointerId,
      tool,
      start: point,
      last: point,
      path: [point],
      displayed,
      ...(tool === 'brush' || tool === 'eraser' ? { before: pixelsOf(mask) } : {}),
    }
    setDrawing(true)
    if (tool === 'brush' || tool === 'eraser') paint([point], tool, displayed)
  }

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const pointer = pointerRef.current
    if (!pointer || pointer.id !== event.pointerId) return
    const point = pointOnImage(event)
    if (!point) return
    if (pointer.tool === 'brush' || pointer.tool === 'eraser') {
      paint([pointer.last, point], pointer.tool, pointer.displayed)
    } else if (pointer.tool === 'lasso') {
      pointer.path.push(point)
      setSketch([...pointer.path])
    } else if (pointer.tool === 'box') {
      const first = pointer.start
      setSketch([first, { x: point.x, y: first.y }, point, { x: first.x, y: point.y }])
    } else if (pointer.tool === 'arrow') setSketch([pointer.start, point])
    pointer.last = point
  }

  const stop = (event: PointerEvent<HTMLDivElement>) => {
    const pointer = pointerRef.current
    if (!pointer || pointer.id !== event.pointerId) return
    pointerRef.current = null
    setDrawing(false)
    setSketch(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    const mask = maskRef.current
    if (!mask) return
    if (event.type !== 'pointerup') {
      if (pointer.before) mask.getContext('2d')!.putImageData(pointer.before, 0, 0)
      redraw()
      return
    }
    if (pointer.tool === 'brush' || pointer.tool === 'eraser') remember({ pixels: pointer.before! })
    else if (pointer.tool === 'lasso' || pointer.tool === 'box') {
      const path =
        pointer.tool === 'box'
          ? [
              pointer.start,
              { x: pointer.last.x, y: pointer.start.y },
              pointer.last,
              { x: pointer.start.x, y: pointer.last.y },
            ]
          : pointer.path
      const pixels = path.map((point) => ({ x: point.x * mask.width, y: point.y * mask.height }))
      if (isUsableMaskLasso(pixels)) {
        remember()
        fillMaskLasso(mask.getContext('2d')!, pixels, true)
      }
    } else if (
      pointer.tool === 'arrow' &&
      Math.hypot(pointer.last.x - pointer.start.x, pointer.last.y - pointer.start.y) > 0.02 &&
      annotations.length < MAX_ANNOTATIONS
    )
      addAnnotation({
        id: nextAnnotationRef.current++,
        kind: 'arrow',
        from: pointer.start,
        to: pointer.last,
        note: '',
      })
    redraw()
  }

  const confirm = async () => {
    const mask = maskRef.current
    if (!mask || locked || !ready || refining) return
    setSubmitting(true)
    try {
      // 服务端分割时已经外扩过一圈；用户手画的部分按他画的来，不再另外外扩。
      const subject = readTarget(mask)
      const target = inverted
        ? invertMask(subject, invertInset(subject.width, subject.height))
        : subject
      if (maskArea(target) === 0) {
        showToast(t('maskProposal.empty'), 'error')
        return
      }
      // 原件已在云端（提议里的 mediaId）：能上传就只传新画的遮罩、按 id 发，原件不再下回来内联——
      // 4K 原图内联一次就超过请求体 4,000,000 字符的上限。只有既没有附件通道也没有云同步时才内联。
      const original =
        attachmentUploadsEnabled() || mediaFallbackEnabled()
          ? undefined
          : await inlineOriginal(source)
      const reference = maskAnswerReference(
        proposal,
        await maskDataUrl(target),
        annotationRegions(annotations),
        original,
      )
      const text = maskAnswerText(proposal, annotations, {
        confirmed: t('maskProposal.answerConfirmed'),
        keep: t('maskProposal.answerKeep'),
        annotation: t('maskProposal.answerAnnotation'),
        arrow: t('maskProposal.answerArrow'),
      })
      await useAgentStore
        .getState()
        .send(text, [reference], undefined, 'image', undefined, undefined, proposal.model.id)
    } catch {
      showToast(t('maskProposal.prepareFailed'), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const stateChip =
    status === 'loading'
      ? { look: 'loading', icon: 'loading' as const, text: t('maskProposal.preparing') }
      : status === 'failed'
        ? { look: 'warning', icon: 'warning' as const, text: t('maskProposal.loadFailed') }
        : refining
          ? { look: 'loading', icon: 'loading' as const, text: t('maskProposal.refining') }
          : touched
            ? { look: 'edited', icon: 'edit' as const, text: t('maskProposal.stateEdited') }
            : status === 'rough'
              ? { look: 'warning', icon: 'warning' as const, text: t('maskProposal.rough') }
              : { look: 'suggested', icon: 'wand' as const, text: t('maskProposal.stateSuggested') }

  const toolButton = (one: (typeof SHAPE_TOOLS)[number] | (typeof NOTE_TOOLS)[number]) => (
    <Button
      key={one.tool}
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={t(one.label)}
      title={t(one.label)}
      aria-pressed={tool === one.tool}
      disabled={locked || drawing}
      onClick={() => setTool(one.tool)}
    >
      <Icon name={one.icon} />
    </Button>
  )

  return (
    <section
      className="studio-mask-proposal"
      data-editing={editing || tool === 'brush' || tool === 'eraser' || undefined}
      data-look={look}
      aria-label={message.question}
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement) return
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
          event.preventDefault()
          restore(event.shiftKey ? 'redo' : 'undo')
        }
      }}
    >
      <h3 className="studio-mask-proposal-title">
        <Icon name="selectLasso" size="sm" />
        {t('maskProposal.title')}
      </h3>
      <div className="studio-mask-proposal-toolbar" role="toolbar">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={tool === 'point'}
          disabled={locked || drawing}
          onClick={() => setTool('point')}
        >
          <Icon name="select" />
          {t('maskProposal.toolPoint')}
        </Button>
        {tool === 'point' && (
          <SegmentedTabs
            label={t('maskProposal.toolPoint')}
            value={pointMode}
            onChange={setPointMode}
            tabs={(['include', 'exclude'] as const).map((mode) => ({
              value: mode,
              label: (
                <span className="studio-mask-proposal-segment">
                  <Icon name={mode === 'include' ? 'add' : 'erase'} size="sm" />
                  {t(
                    mode === 'include' ? 'maskProposal.pointInclude' : 'maskProposal.pointExclude',
                  )}
                </span>
              ),
            }))}
          />
        )}
        <span className="studio-artifact-edit-tool-divider" />
        {PAINT_TOOLS.map((one) => (
          <Button
            key={one.tool}
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={tool === one.tool}
            title={t(one.tool === 'brush' ? 'maskProposal.brushTitle' : 'maskProposal.eraserTitle')}
            disabled={locked || drawing || !ready}
            onClick={() => setTool(one.tool)}
          >
            <Icon name={one.icon} />
            {t(one.label)}
          </Button>
        ))}
        {(tool === 'brush' || tool === 'eraser') && (
          <span className="studio-mask-proposal-brush">
            <span>{t('maskProposal.brushSize')}</span>
            <Slider
              aria-label={t('maskProposal.brushSize')}
              min={6}
              max={120}
              value={[brush]}
              onValueChange={([value]) => setBrush(value ?? brush)}
              disabled={locked || drawing}
              className="w-20"
            />
          </span>
        )}
        {editing && (
          <>
            <span className="studio-artifact-edit-tool-divider" />
            {SHAPE_TOOLS.map(toolButton)}
            <span className="studio-artifact-edit-tool-divider" />
            {NOTE_TOOLS.map(toolButton)}
          </>
        )}
        <span className="studio-artifact-edit-tool-divider" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={inverted}
          title={t('maskProposal.invertTitle')}
          disabled={locked || drawing || refining || !ready}
          onClick={toggleInverted}
        >
          <Icon name="replace" />
          {t('maskProposal.invert')}
        </Button>
        <span className="studio-artifact-edit-tool-divider" />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('maskProposal.undo')}
          title={t('maskProposal.undo')}
          disabled={!history.undo || locked || drawing || refining}
          onClick={() => restore('undo')}
        >
          <Icon name="undo" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('maskProposal.redo')}
          title={t('maskProposal.redo')}
          disabled={!history.redo || locked || drawing || refining}
          onClick={() => restore('redo')}
        >
          <Icon name="redo" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title={t('maskProposal.resetTitle')}
          disabled={!touched || locked || drawing || refining || !ready}
          onClick={resetToAuto}
        >
          <Icon name="refresh" />
          {t('maskProposal.reset')}
        </Button>
      </div>
      <div className="studio-mask-proposal-stage">
        {source ? (
          <div className="studio-mask-proposal-image">
            <img ref={imageRef} src={source} alt="" draggable={false} onLoad={redraw} />
            <canvas ref={previewRef} aria-hidden="true" />
            {!locked && ready && (
              <div
                className="studio-mask-proposal-hit"
                data-tool={tool}
                data-exclude={(tool === 'point' && pointMode === 'exclude') || undefined}
                onPointerDown={start}
                onPointerMove={move}
                onPointerUp={stop}
                onPointerCancel={stop}
              />
            )}
            {regions.flatMap((region) =>
              region.clicks.map((one, index) => (
                <span
                  key={`${region.number}-${index}`}
                  className="studio-mask-proposal-point"
                  data-exclude={!one.include || undefined}
                  style={{ left: `${one.x * 100}%`, top: `${one.y * 100}%` }}
                >
                  <Icon name={one.include ? 'add' : 'close'} size="sm" />
                </span>
              )),
            )}
            {numbered &&
              regions.map((region) => (
                <span
                  key={region.number}
                  className="studio-mask-proposal-region"
                  data-selected={region.selected || undefined}
                  style={{ left: `${region.box.x * 100}%`, top: `${region.box.y * 100}%` }}
                  aria-hidden="true"
                >
                  {region.number}
                </span>
              ))}
            {annotations.map((annotation, index) => {
              const at = annotation.kind === 'arrow' ? annotation.from : annotation.at
              return (
                <span
                  key={annotation.id}
                  className="studio-mask-proposal-badge"
                  style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}
                >
                  {index + 1}
                </span>
              )
            })}
          </div>
        ) : (
          <div className="studio-mask-proposal-placeholder" />
        )}
        <span className="studio-mask-proposal-state" data-look={stateChip.look} role="status">
          <Icon
            name={stateChip.icon}
            size="sm"
            className={stateChip.look === 'loading' ? 'animate-spin' : undefined}
          />
          {stateChip.text}
        </span>
      </div>
      {ready && (
        <p className="studio-mask-proposal-hint">
          {inverted
            ? t('maskProposal.invertHint')
            : tool === 'point'
              ? t('maskProposal.pointHint')
              : tool === 'brush' || tool === 'eraser'
                ? t('maskProposal.brushHint')
                : t('maskProposal.edgeHint')}
        </p>
      )}
      {numbered && (
        <div className="studio-mask-proposal-regions">
          <span className="studio-mask-proposal-muted">
            {t('maskProposal.regions', { count: regions.length })}
          </span>
          <div role="group">
            {regions.map((region) => (
              <Button
                key={region.number}
                type="button"
                variant="outline"
                size="xs"
                aria-pressed={region.selected}
                disabled={locked || !ready || refining}
                onClick={() => toggleRegion(region.number)}
              >
                <span
                  className="studio-mask-proposal-region"
                  data-static
                  data-selected={region.selected || undefined}
                >
                  {region.number}
                </span>
                {region.label ?? t('maskProposal.region', { number: region.number })}
              </Button>
            ))}
          </div>
        </div>
      )}
      {editing && (
        <div className="studio-mask-proposal-notes">
          {annotations.length > 0 && (
            <ol>
              {annotations.map((annotation, index) => (
                <li key={annotation.id}>
                  <span className="studio-mask-proposal-badge" data-static>
                    {index + 1}
                  </span>
                  <Input
                    ref={(node) => {
                      if (node) noteRefs.current.set(annotation.id, node)
                      else noteRefs.current.delete(annotation.id)
                    }}
                    value={annotation.note}
                    maxLength={120}
                    disabled={locked}
                    placeholder={t('maskProposal.annotationPlaceholder')}
                    onChange={(event) => {
                      const note = event.target.value
                      setAnnotations((current) =>
                        current.map((one) => (one.id === annotation.id ? { ...one, note } : one)),
                      )
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('maskProposal.removeAnnotation', { number: index + 1 })}
                    disabled={locked}
                    onClick={() => {
                      remember()
                      setAnnotations((current) => current.filter((one) => one.id !== annotation.id))
                    }}
                  >
                    <Icon name="close" />
                  </Button>
                </li>
              ))}
            </ol>
          )}
          <p className="studio-mask-proposal-muted">{t('maskProposal.annotationHint')}</p>
        </div>
      )}
      <dl className="studio-mask-proposal-reading">
        <div>
          <dt>{t('maskProposal.change')}</dt>
          <dd>
            {proposal.target}，{proposal.change}
          </dd>
        </div>
        {proposal.keep.length > 0 && (
          <div>
            <dt>{t('maskProposal.keep')}</dt>
            <dd>{proposal.keep.join('、')}</dd>
          </div>
        )}
      </dl>
      <p className="studio-mask-proposal-muted">
        <Icon name="lock" size="sm" />
        {t('maskProposal.lock')}
      </p>
      {tool === 'point' && (
        <p className="studio-mask-proposal-muted">
          <Icon name="tip" size="sm" />
          {t('maskProposal.edgeHint')}
        </p>
      )}
      <p className="studio-mask-proposal-muted">
        <Icon name="model" size="sm" />
        {proposal.switchedFrom
          ? t('maskProposal.switched', {
              from: proposal.switchedFrom.label,
              model: proposal.model.label,
            })
          : t('maskProposal.model', { model: proposal.model.label })}
      </p>
      <div className="studio-mask-proposal-actions">
        <Button
          type="button"
          size="sm"
          disabled={locked || drawing || refining || !ready}
          onClick={() => void confirm()}
        >
          {submitting ? <Icon name="loading" className="animate-spin" /> : <Icon name="check" />}
          {t('maskProposal.confirm', { count: outputs })}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={locked || !ready}
          onClick={() => {
            setEditing((value) => !value)
            if (editing && tool !== 'point' && tool !== 'brush' && tool !== 'eraser')
              setTool('point')
          }}
        >
          <Icon name={editing ? 'close' : 'brush'} />
          {editing ? t('maskProposal.cancelAdjust') : t('maskProposal.adjust')}
        </Button>
        {!editing && !writing && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={locked}
            onClick={() => setWriting(true)}
          >
            {t('maskProposal.other')}
          </Button>
        )}
      </div>
      {writing && !editing && (
        <form
          className="studio-clarification-other-form"
          onSubmit={(event) => {
            event.preventDefault()
            const written = other.trim()
            if (locked || !written) return
            void useAgentStore.getState().send(written)
          }}
        >
          <Input
            autoFocus
            aria-label={t('clarification.otherAria')}
            value={other}
            disabled={locked}
            placeholder={t('clarification.otherPlaceholder')}
            onChange={(event) => setOther(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
            }}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            type="submit"
            disabled={locked || !other.trim()}
            aria-label={t('composer.send')}
          >
            <Icon name="send" />
          </Button>
        </form>
      )}
    </section>
  )
}
