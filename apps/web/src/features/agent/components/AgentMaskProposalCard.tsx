import type { AgentMaskProposal } from '@image-playground/shared'
import { type PointerEvent, useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { Checkbox } from '../../../components/ui/checkbox'
import { Icon } from '../../../components/ui/icon'
import { Input } from '../../../components/ui/input'
import { Slider } from '../../../components/ui/slider'
import { useTranslation } from '../../../i18n'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import { fillMaskLasso, isUsableMaskLasso } from '../../../lib/mask'
import { useStore } from '../../../store'
import { attachmentUploadsEnabled } from '../lib/attachmentUploads'
import {
  annotationRegions,
  dilateMask,
  editMaskRgba,
  MASK_EDGE_EXPAND_PX,
  type MaskAnnotation,
  maskAnswerReference,
  maskAnswerText,
  maskArea,
  type Point,
  type TargetMask,
} from '../lib/maskProposal'
import { browserSegmenter } from '../lib/segmentClient'
import { useAgentStore } from '../store'
import type { AgentClarificationMessage } from '../types'

type Tool = 'lasso' | 'box' | 'brush' | 'eraser' | 'arrow' | 'text'
type Status = 'loading' | 'segmenting' | 'refined' | 'rough' | 'failed'
type Snapshot = { pixels: ImageData; annotations: MaskAnnotation[] }

/** 覆盖层只画在缩小的预览上；导出的蒙版始终是原图尺寸。 */
const PREVIEW_EDGE = 1024
const HISTORY_BYTES = 32 * 1024 * 1024
const MAX_ANNOTATIONS = 12
const TOOLS = [
  { tool: 'lasso', icon: 'selectLasso', label: 'maskProposal.toolLasso' },
  { tool: 'box', icon: 'selectRectangle', label: 'maskProposal.toolBox' },
  { tool: 'brush', icon: 'brush', label: 'maskProposal.toolBrush' },
  { tool: 'eraser', icon: 'erase', label: 'maskProposal.toolEraser' },
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

function readTarget(canvas: HTMLCanvasElement): TargetMask {
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
  const target = new Uint8Array(canvas.width * canvas.height)
  for (let index = 0; index < target.length; index++)
    target[index] = data[index * 4 + 3]! >= 128 ? 1 : 0
  return { data: target, width: canvas.width, height: canvas.height }
}

function writeTarget(canvas: HTMLCanvasElement, mask: TargetMask) {
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  const pixels = context.createImageData(mask.width, mask.height)
  for (let index = 0; index < mask.data.length; index++)
    if (mask.data[index]) pixels.data.set([255, 255, 255, 255], index * 4)
  context.putImageData(pixels, 0, 0)
}

function maskDataUrl(mask: TargetMask): string {
  const canvas = document.createElement('canvas')
  canvas.width = mask.width
  canvas.height = mask.height
  const context = canvas.getContext('2d')!
  context.putImageData(new ImageData(editMaskRgba(mask), mask.width, mask.height), 0, 0)
  return canvas.toDataURL('image/png')
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

export function AnsweredMaskProposal({
  proposal,
  confirmed,
}: {
  proposal: AgentMaskProposal
  confirmed: boolean
}) {
  const { t } = useTranslation('agent')
  return (
    <div className="studio-clarification-answered studio-clarification-answered--unknown">
      <Icon name="check" size="sm" />
      <span>
        {confirmed
          ? t('maskProposal.answered', { target: proposal.target })
          : t('maskProposal.answeredOther')}
      </span>
    </div>
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
  const running = useAgentStore((state) => state.turn === 'running')
  const imageRef = useRef<HTMLImageElement>(null)
  const maskRef = useRef<HTMLCanvasElement | null>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef<number | null>(null)
  const touchedRef = useRef(false)
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
  const [editing, setEditing] = useState(false)
  const [tool, setTool] = useState<Tool>('brush')
  const [brush, setBrush] = useState(24)
  const [expand, setExpand] = useState(true)
  const [annotations, setAnnotations] = useState<MaskAnnotation[]>([])
  const [history, setHistory] = useState({ undo: false, redo: false })
  const [drawing, setDrawing] = useState(false)
  const [sketch, setSketch] = useState<Point[] | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [writing, setWriting] = useState(false)
  const [other, setOther] = useState('')
  const locked = answered || running || submitting

  const redrawNow = useCallback(() => {
    frameRef.current = null
    const mask = maskRef.current
    const preview = previewRef.current
    const context = preview?.getContext('2d')
    if (!mask || !preview || !context) return
    context.clearRect(0, 0, preview.width, preview.height)
    // 范围外压暗、范围内着蓝：一眼看出改哪里、哪里不动。
    context.save()
    context.fillStyle = 'rgba(0, 0, 0, 0.35)'
    context.fillRect(0, 0, preview.width, preview.height)
    context.globalCompositeOperation = 'destination-out'
    context.drawImage(mask, 0, 0, preview.width, preview.height)
    context.restore()
    const tint = document.createElement('canvas')
    tint.width = preview.width
    tint.height = preview.height
    const tintContext = tint.getContext('2d')!
    tintContext.drawImage(mask, 0, 0, preview.width, preview.height)
    tintContext.globalCompositeOperation = 'source-in'
    tintContext.fillStyle = annotationColor(0.45)
    tintContext.fillRect(0, 0, preview.width, preview.height)
    context.drawImage(tint, 0, 0)
    const scale = preview.width / Math.max(1, imageRef.current?.getBoundingClientRect().width ?? 1)
    const strokes = [
      ...annotations.flatMap((annotation) =>
        annotation.kind === 'arrow' ? [[annotation.from, annotation.to] as const] : [],
      ),
      ...(sketch && pointerRef.current?.tool === 'arrow' && sketch.length === 2
        ? [[sketch[0]!, sketch[1]!] as const]
        : []),
    ]
    context.save()
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
  }, [annotations, sketch])

  const redraw = useCallback(() => {
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(redrawNow)
  }, [redrawNow])

  useEffect(() => {
    redraw()
  }, [redraw])
  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    },
    [],
  )

  // 原图、初始蒙版：服务端分割过就用它的，否则先给外接框，再在浏览器里按对象轮廓细化。
  useEffect(() => {
    if (answered) return
    let active = true
    const controller = new AbortController()
    void (async () => {
      try {
        const resolved = await resolveMediaSource(`aip-media:${proposal.mediaId}`, 'original', true)
        if (!active) return
        setSource(resolved)
        const image = await loadImage(resolved)
        if (!active) return
        const mask = document.createElement('canvas')
        mask.width = image.naturalWidth
        mask.height = image.naturalHeight
        maskRef.current = mask
        const preview = previewRef.current
        if (preview) {
          const scale = Math.min(1, PREVIEW_EDGE / Math.max(mask.width, mask.height))
          preview.width = Math.max(1, Math.round(mask.width * scale))
          preview.height = Math.max(1, Math.round(mask.height * scale))
        }
        if (proposal.maskMediaId) {
          const server = await loadImage(
            await resolveMediaSource(`aip-media:${proposal.maskMediaId}`, 'original', true),
          )
          const scratch = document.createElement('canvas')
          scratch.width = mask.width
          scratch.height = mask.height
          const context = scratch.getContext('2d', { willReadFrequently: true })!
          context.drawImage(server, 0, 0, mask.width, mask.height)
          const { data } = context.getImageData(0, 0, mask.width, mask.height)
          const target = new Uint8Array(mask.width * mask.height)
          for (let index = 0; index < target.length; index++)
            target[index] = data[index * 4 + 3]! < 128 ? 1 : 0
          if (!active) return
          writeTarget(mask, { data: target, width: mask.width, height: mask.height })
          setStatus('refined')
          redraw()
          return
        }
        const context = mask.getContext('2d')!
        context.fillStyle = '#fff'
        const { box } = proposal
        context.fillRect(
          box.x * mask.width,
          box.y * mask.height,
          box.width * mask.width,
          box.height * mask.height,
        )
        setStatus('segmenting')
        redraw()
        const segmented = await browserSegmenter
          .segment({
            image,
            box,
            ...(proposal.points ? { points: proposal.points } : {}),
            signal: controller.signal,
          })
          .catch(() => null)
        if (!active) return
        if (segmented && !touchedRef.current) {
          writeTarget(mask, segmented)
          setStatus('refined')
        } else setStatus('rough')
        redraw()
      } catch {
        if (active) setStatus('failed')
      }
    })()
    return () => {
      active = false
      controller.abort()
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

  const remember = (pixels?: ImageData) => {
    const mask = maskRef.current
    if (!mask) return
    const context = mask.getContext('2d', { willReadFrequently: true })!
    undoRef.current.push({
      pixels: pixels ?? context.getImageData(0, 0, mask.width, mask.height),
      annotations,
    })
    const limit = Math.max(
      1,
      Math.min(20, Math.floor(HISTORY_BYTES / (mask.width * mask.height * 4))),
    )
    while (undoRef.current.length > limit) undoRef.current.shift()
    redoRef.current = []
    touchedRef.current = true
    setHistory({ undo: true, redo: false })
  }

  const restore = (direction: 'undo' | 'redo') => {
    const mask = maskRef.current
    if (!mask || pointerRef.current) return
    const from = direction === 'undo' ? undoRef.current : redoRef.current
    const to = direction === 'undo' ? redoRef.current : undoRef.current
    const previous = from.pop()
    if (!previous) return
    const context = mask.getContext('2d', { willReadFrequently: true })!
    to.push({ pixels: context.getImageData(0, 0, mask.width, mask.height), annotations })
    context.putImageData(previous.pixels, 0, 0)
    setAnnotations(previous.annotations)
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

  const addAnnotation = (annotation: MaskAnnotation) => {
    remember()
    setAnnotations((current) => [...current, annotation])
    requestAnimationFrame(() => noteRefs.current.get(annotation.id)?.focus())
  }

  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (!editing || locked || event.button !== 0 || pointerRef.current || !maskRef.current) return
    const point = pointOnImage(event)
    if (!point) return
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
        ? {
            before: mask
              .getContext('2d', { willReadFrequently: true })!
              .getImageData(0, 0, mask.width, mask.height),
          }
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
    if (pointer.tool === 'brush' || pointer.tool === 'eraser') remember(pointer.before)
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
    if (!mask || locked || status === 'loading' || status === 'failed') return
    setSubmitting(true)
    try {
      let target = readTarget(mask)
      if (expand) target = dilateMask(target, MASK_EDGE_EXPAND_PX)
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

  const statusText =
    status === 'segmenting'
      ? t('maskProposal.segmenting')
      : status === 'rough'
        ? t('maskProposal.rough')
        : status === 'failed'
          ? t('maskProposal.loadFailed')
          : status === 'refined'
            ? t('maskProposal.refined')
            : t('maskProposal.preparing')

  return (
    <section
      className="studio-mask-proposal"
      data-editing={editing || undefined}
      aria-label={message.question}
      onKeyDown={(event) => {
        if (!editing || event.target instanceof HTMLInputElement) return
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
      {editing && (
        <div className="studio-mask-proposal-toolbar" role="toolbar">
          {TOOLS.map((one) => (
            <Button
              key={one.tool}
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t(one.label)}
              aria-pressed={tool === one.tool}
              disabled={locked || drawing}
              onClick={() => setTool(one.tool)}
            >
              <Icon name={one.icon} />
            </Button>
          ))}
          <span className="studio-artifact-edit-tool-divider" />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('maskProposal.undo')}
            disabled={!history.undo || locked || drawing}
            onClick={() => restore('undo')}
          >
            <Icon name="undo" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('maskProposal.redo')}
            disabled={!history.redo || locked || drawing}
            onClick={() => restore('redo')}
          >
            <Icon name="redo" />
          </Button>
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
        </div>
      )}
      <div className="studio-mask-proposal-stage">
        {source ? (
          <div className="studio-mask-proposal-image">
            <img ref={imageRef} src={source} alt="" draggable={false} onLoad={redraw} />
            <canvas ref={previewRef} aria-hidden="true" />
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
            {editing && (
              <div
                className="studio-mask-proposal-hit"
                data-tool={tool}
                onPointerDown={start}
                onPointerMove={move}
                onPointerUp={stop}
                onPointerCancel={stop}
              />
            )}
          </div>
        ) : (
          <div className="studio-mask-proposal-placeholder" />
        )}
        <span className="studio-mask-proposal-status" data-status={status} role="status">
          {status === 'segmenting' || status === 'loading' ? (
            <Icon name="loading" size="sm" className="animate-spin" />
          ) : status === 'rough' || status === 'failed' ? (
            <Icon name="warning" size="sm" />
          ) : (
            <Icon name="check" size="sm" />
          )}
          {statusText}
        </span>
      </div>
      {editing && (
        <div className="studio-mask-proposal-notes">
          <label className="studio-mask-proposal-expand">
            <Checkbox
              checked={expand}
              disabled={locked}
              onCheckedChange={(value) => setExpand(value === true)}
            />
            <span>{t('maskProposal.edgeExpand')}</span>
          </label>
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
          disabled={locked || drawing || status === 'loading' || status === 'failed'}
          onClick={() => void confirm()}
        >
          {submitting ? <Icon name="loading" className="animate-spin" /> : <Icon name="check" />}
          {t('maskProposal.confirm')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={locked || status === 'loading' || status === 'failed'}
          onClick={() => setEditing((value) => !value)}
        >
          <Icon name={editing ? 'close' : 'edit'} />
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
