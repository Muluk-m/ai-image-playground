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
import { refineEditRegion } from '../lib/agentClient'
import { attachmentUploadsEnabled } from '../lib/attachmentUploads'
import {
  annotationRegions,
  editMaskRgba,
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
type Snapshot = {
  pixels: ImageData
  annotations: MaskAnnotation[]
  regions: RegionState[]
  regionMask?: { number: number; pixels: ImageData }
}

/** 覆盖层只画在缩小的预览上；导出的蒙版始终是原图尺寸。 */
const PREVIEW_EDGE = 1024
const HISTORY_BYTES = 32 * 1024 * 1024
const MAX_ANNOTATIONS = 12
const MAX_CLICKS = 12
/** 点选是主工具；画笔、橡皮、框、套索补细节；箭头与文字只做说明。 */
const SHAPE_TOOLS = [
  { tool: 'brush', icon: 'brush', label: 'maskProposal.toolBrush' },
  { tool: 'eraser', icon: 'erase', label: 'maskProposal.toolEraser' },
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

function maskDataUrl(mask: TargetMask): string {
  const canvas = canvasOf(mask.width, mask.height)
  canvas
    .getContext('2d')!
    .putImageData(new ImageData(editMaskRgba(mask), mask.width, mask.height), 0, 0)
  return canvas.toDataURL('image/png')
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
    width: number
    before?: ImageData
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
    paintOverlay(preview, mask, look, scale)
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
  }, [annotations, look, numbered, regions, sketch])

  const redraw = useCallback(() => {
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(redrawNow)
  }, [redrawNow])

  useEffect(() => {
    redraw()
  }, [redraw])
  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
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

  const remember = (extra: Partial<Pick<Snapshot, 'pixels' | 'regionMask'>> = {}) => {
    const mask = maskRef.current
    if (!mask) return
    undoRef.current.push({
      pixels: extra.pixels ?? context2d(mask).getImageData(0, 0, mask.width, mask.height),
      annotations,
      regions,
      ...(extra.regionMask ? { regionMask: extra.regionMask } : {}),
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
    const regionCanvas = previous.regionMask
      ? regionMasksRef.current.get(previous.regionMask.number)
      : undefined
    to.push({
      pixels: context2d(mask).getImageData(0, 0, mask.width, mask.height),
      annotations,
      regions,
      ...(previous.regionMask && regionCanvas
        ? {
            regionMask: {
              number: previous.regionMask.number,
              pixels: context2d(regionCanvas).getImageData(0, 0, mask.width, mask.height),
            },
          }
        : {}),
    })
    context2d(mask).putImageData(previous.pixels, 0, 0)
    if (previous.regionMask && regionCanvas)
      context2d(regionCanvas).putImageData(previous.regionMask.pixels, 0, 0)
    setAnnotations(previous.annotations)
    setRegions(previous.regions)
    setHistory({ undo: undoRef.current.length > 0, redo: redoRef.current.length > 0 })
    redraw()
  }

  const paint = (from: Point, to: Point, erase: boolean, width: number) => {
    const mask = maskRef.current
    if (!mask) return
    const context = mask.getContext('2d')!
    context.save()
    context.globalCompositeOperation = erase ? 'destination-out' : 'source-over'
    context.strokeStyle = context.fillStyle = '#fff'
    context.lineWidth = width
    context.lineCap = context.lineJoin = 'round'
    context.beginPath()
    context.moveTo(from.x * mask.width, from.y * mask.height)
    context.lineTo(to.x * mask.width, to.y * mask.height)
    context.stroke()
    context.restore()
    redraw()
  }

  /** 把一个区域的新蒙版换进总范围：先去掉它旧的那份，选中时再放进新的。 */
  const swapRegionMask = (number: number, next: HTMLCanvasElement, selected: boolean) => {
    const mask = maskRef.current
    const current = regionMasksRef.current.get(number)
    if (!mask || !current) return
    const context = mask.getContext('2d')!
    context.save()
    context.globalCompositeOperation = 'destination-out'
    context.drawImage(current, 0, 0)
    context.restore()
    if (selected) context.drawImage(next, 0, 0)
    const keep = context2d(current)
    keep.clearRect(0, 0, current.width, current.height)
    keep.drawImage(next, 0, 0)
  }

  const toggleRegion = (number: number) => {
    const mask = maskRef.current
    const regionMask = regionMasksRef.current.get(number)
    const region = regions.find((one) => one.number === number)
    if (!mask || !regionMask || !region || locked || refining) return
    remember()
    const context = mask.getContext('2d')!
    context.save()
    if (region.selected) context.globalCompositeOperation = 'destination-out'
    context.drawImage(regionMask, 0, 0)
    context.restore()
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
    const clicks = [...region.clicks, { x: point.x, y: point.y, include }].slice(-MAX_CLICKS)
    const selected = region.selected || include
    const regionCanvas = regionMasksRef.current.get(number)!
    remember({
      regionMask: {
        number,
        pixels: context2d(regionCanvas).getImageData(0, 0, mask.width, mask.height),
      },
    })
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
      width: Math.max(2, (brush * mask.width) / displayed),
      ...(tool === 'brush' || tool === 'eraser'
        ? { before: context2d(mask).getImageData(0, 0, mask.width, mask.height) }
        : {}),
    }
    setDrawing(true)
    if (tool === 'brush' || tool === 'eraser')
      paint(point, point, tool === 'eraser', pointerRef.current.width)
  }

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const pointer = pointerRef.current
    if (!pointer || pointer.id !== event.pointerId) return
    const point = pointOnImage(event)
    if (!point) return
    if (pointer.tool === 'brush' || pointer.tool === 'eraser') {
      paint(pointer.last, point, pointer.tool === 'eraser', pointer.width)
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
      const target = readTarget(mask)
      if (maskArea(target) === 0) {
        showToast(t('maskProposal.empty'), 'error')
        return
      }
      const original = attachmentUploadsEnabled() ? undefined : await inlineOriginal(source)
      const reference = maskAnswerReference(
        proposal,
        maskDataUrl(target),
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
      data-editing={editing || undefined}
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
        {editing && (tool === 'brush' || tool === 'eraser') && (
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
          {tool === 'point' ? t('maskProposal.pointHint') : t('maskProposal.edgeHint')}
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
            if (editing && tool !== 'point') setTool('point')
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
