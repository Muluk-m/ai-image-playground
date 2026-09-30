import {
  Brush,
  Crop,
  Eraser,
  Hand,
  Lasso,
  Maximize,
  Minus,
  Plus,
  Redo2,
  Square,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import { type PointerEvent, useEffect, useRef, useState } from 'react'
import Overlay from '../../../components/Overlay'
import { Button } from '../../../components/ui/button'
import { Slider } from '../../../components/ui/slider'
import { useTranslation } from '../../../i18n'
import { classifyMaskAlpha, fillMaskLasso, isUsableMaskLasso } from '../../../lib/mask'
import { prepareMaskTargetDataUrl } from '../../../lib/maskPreprocess'
import { useStore } from '../../../store'
import {
  type ArtifactEditAction,
  type ArtifactEditInput,
  type CropRect,
  cropImage,
  exportMarkedImage,
  extendImage,
} from '../lib/artifactEdit'

type MarkTool = 'lasso' | 'rectangle' | 'brush' | 'eraser' | 'pan'
type Point = { x: number; y: number }
type Mark = { id: number; tool: Exclude<MarkTool, 'pan'>; points: Point[]; width: number }
type MarkSnapshot = { pixels: ImageData; marks: Mark[] }
function markBounds(mark: Mark) {
  const xs = mark.points.map((point) => point.x)
  const ys = mark.points.map((point) => point.y)
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  }
}
const DEFAULT_CROP: CropRect = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }

export default function AgentArtifactEditDialog({
  action,
  source,
  busy,
  onClose,
  onGenerate,
}: {
  action: ArtifactEditAction
  source: string
  busy: boolean
  onClose: () => void
  onGenerate: (input: ArtifactEditInput, instruction: string) => void
}) {
  const { t } = useTranslation('agent')
  const showToast = useStore((state) => state.showToast)
  const dialogRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const lassoRef = useRef<Point[]>([])
  const previewFrameRef = useRef<number | null>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const maskRef = useRef<HTMLCanvasElement>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)
  const pointerRef = useRef<{
    id: number
    tool: MarkTool
    last: Point
    start?: Point
    pan?: Point
    points?: Point[]
    width?: number
    before?: ImageData
  } | null>(null)
  const marksRef = useRef<Mark[]>([])
  const nextMarkRef = useRef(1)
  const [marks, setMarks] = useState<Mark[]>([])
  const undoRef = useRef<MarkSnapshot[]>([])
  const redoRef = useRef<MarkSnapshot[]>([])
  const [working, setWorking] = useState('')
  const [loading, setLoading] = useState(true)
  const [instruction, setInstruction] = useState('')
  const [drawing, setDrawing] = useState(false)
  const [tool, setTool] = useState<MarkTool>('brush')
  const [brush, setBrush] = useState(10)
  const [ready, setReady] = useState(false)
  const [imageSize, setImageSize] = useState<Point>({ x: 0, y: 0 })
  const [stageSize, setStageSize] = useState<Point>({ x: 800, y: 440 })
  const [cursor, setCursor] = useState<Point | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 })
  const [crop, setCrop] = useState<CropRect>(DEFAULT_CROP)
  const [extension, setExtension] = useState(0.25)
  const [markPresent, setMarkPresent] = useState(false)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const marked = action === 'inpaint' || action === 'erase'

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.focus()
    return () => previous?.focus()
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    setReady(false)
    setDrawing(false)
    pointerRef.current = null
    lassoRef.current = []
    setWorking('')
    setImageSize({ x: 0, y: 0 })
    setMarkPresent(false)
    setPan({ x: 0, y: 0 })
    setZoom(1)
    void prepareMaskTargetDataUrl(source)
      .then((prepared) => {
        if (active) setWorking(prepared.dataUrl)
      })
      .catch((error) => {
        if (active) showToast(error instanceof Error ? error.message : String(error), 'error')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [source, showToast])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const update = () => {
      const style = getComputedStyle(stage)
      setStageSize({
        x: Math.max(
          1,
          stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        ),
        y: Math.max(
          1,
          stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
        ),
      })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  const redrawPreviewNow = () => {
    previewFrameRef.current = null
    const mask = maskRef.current
    const preview = previewRef.current
    const context = preview?.getContext('2d')
    if (!mask || !preview || !context) return
    context.clearRect(0, 0, preview.width, preview.height)
    context.save()
    context.fillStyle = 'rgba(59, 130, 246, .58)'
    context.fillRect(0, 0, preview.width, preview.height)
    context.globalCompositeOperation = 'destination-out'
    context.drawImage(mask, 0, 0, preview.width, preview.height)
    context.restore()
    const path = lassoRef.current
    if (path.length > 1) {
      context.save()
      context.beginPath()
      context.moveTo(path[0]!.x * preview.width, path[0]!.y * preview.height)
      for (let index = 1; index < path.length; index++)
        context.lineTo(path[index]!.x * preview.width, path[index]!.y * preview.height)
      context.closePath()
      context.fillStyle = 'rgba(59, 130, 246, .35)'
      context.fill()
      context.strokeStyle = '#fff'
      context.lineWidth =
        (2 * preview.width) / Math.max(1, imageRef.current?.getBoundingClientRect().width ?? 1)
      context.stroke()
      context.restore()
    }
  }

  const redrawPreview = () => {
    if (previewFrameRef.current === null)
      previewFrameRef.current = requestAnimationFrame(redrawPreviewNow)
  }
  useEffect(
    () => () => {
      if (previewFrameRef.current !== null) cancelAnimationFrame(previewFrameRef.current)
      previewFrameRef.current = null
    },
    [source],
  )

  const syncMarkPresent = () => {
    const canvas = maskRef.current
    const context = canvas?.getContext('2d', { willReadFrequently: true })
    if (canvas && context)
      setMarkPresent(
        classifyMaskAlpha(context.getImageData(0, 0, canvas.width, canvas.height)) !== 'empty',
      )
  }

  const initializeMask = () => {
    const image = imageRef.current
    const mask = maskRef.current
    const preview = previewRef.current
    if (!image || !image.naturalWidth) return
    setImageSize({ x: image.naturalWidth, y: image.naturalHeight })
    if (!marked) {
      setReady(true)
      return
    }
    if (!mask || !preview) return
    mask.width = image.naturalWidth
    mask.height = image.naturalHeight
    // Only the visual overlay is reduced. The exported mask stays at source resolution.
    const previewScale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight))
    preview.width = Math.max(1, Math.round(image.naturalWidth * previewScale))
    preview.height = Math.max(1, Math.round(image.naturalHeight * previewScale))
    const context = mask.getContext('2d')
    if (!context) return
    context.fillStyle = '#fff'
    context.fillRect(0, 0, mask.width, mask.height)
    undoRef.current = []
    redoRef.current = []
    marksRef.current = []
    setMarks([])
    setCanUndo(false)
    setCanRedo(false)
    setMarkPresent(false)
    lassoRef.current = []
    setImageSize({ x: image.naturalWidth, y: image.naturalHeight })
    setReady(true)
    redrawPreview()
  }

  const pointOnImage = (event: PointerEvent<HTMLElement>): Point | null => {
    const image = imageRef.current
    if (!image) return null
    const box = image.getBoundingClientRect()
    const x = (event.clientX - box.left) / box.width
    const y = (event.clientY - box.top) / box.height
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
  }

  const rememberMask = (before?: ImageData) => {
    const canvas = maskRef.current
    const context = canvas?.getContext('2d', { willReadFrequently: true })
    if (!canvas || !context) return
    undoRef.current.push({
      pixels: before ?? context.getImageData(0, 0, canvas.width, canvas.height),
      marks: marksRef.current,
    })
    // Bound full-resolution history to 32 MiB, including the snapshots moved to redo.
    const limit = Math.max(
      1,
      Math.min(20, Math.floor((32 * 1024 * 1024) / (canvas.width * canvas.height * 4))),
    )
    while (undoRef.current.length > limit) {
      undoRef.current.shift()
    }
    redoRef.current = []
    setCanUndo(true)
    setCanRedo(false)
  }

  const paint = (from: Point, to: Point, gestureTool = tool) => {
    const canvas = maskRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    context.save()
    context.globalCompositeOperation = gestureTool === 'eraser' ? 'source-over' : 'destination-out'
    context.strokeStyle = '#fff'
    context.fillStyle = '#fff'
    context.lineWidth = Math.max(
      4,
      (brush * canvas.width) / Math.max(1, imageRef.current?.getBoundingClientRect().width ?? 1),
    )
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.beginPath()
    context.moveTo(from.x * canvas.width, from.y * canvas.height)
    context.lineTo(to.x * canvas.width, to.y * canvas.height)
    context.stroke()
    context.beginPath()
    context.arc(to.x * canvas.width, to.y * canvas.height, context.lineWidth / 2, 0, Math.PI * 2)
    context.fill()
    context.restore()
    redrawPreview()
  }

  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (
      busy ||
      !ready ||
      !working ||
      event.button !== 0 ||
      pointerRef.current ||
      ((tool === 'rectangle' || tool === 'lasso') &&
        marksRef.current.filter((mark) => mark.tool === 'rectangle' || mark.tool === 'lasso')
          .length >= 32)
    )
      return
    const point = pointOnImage(event)
    if (!point) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dialogRef.current?.focus({ preventScroll: true })
    pointerRef.current = {
      id: event.pointerId,
      tool,
      points: [point],
      width: Math.max(
        4,
        (brush * (maskRef.current?.width ?? 1)) /
          Math.max(1, imageRef.current!.getBoundingClientRect().width),
      ),
      last: point,
      start: point,
      pan: { x: event.clientX - pan.x, y: event.clientY - pan.y },
    }
    setDrawing(true)
    if (marked && tool !== 'pan') {
      if (tool === 'lasso' || tool === 'rectangle') lassoRef.current = [point]
      else {
        const mask = maskRef.current
        const context = mask?.getContext('2d', { willReadFrequently: true })
        if (mask && context)
          pointerRef.current.before = context.getImageData(0, 0, mask.width, mask.height)
        paint(point, point)
      }
    }
  }

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const point = pointOnImage(event)
    setCursor(point)
    const pointer = pointerRef.current
    if (busy || !pointer || pointer.id !== event.pointerId) return
    if (pointer.tool === 'pan' && marked) {
      setPan({ x: event.clientX - pointer.pan!.x, y: event.clientY - pointer.pan!.y })
      return
    }
    if (!point) return
    if (marked) {
      if (pointer.tool === 'lasso') {
        const path = lassoRef.current
        const last = path[path.length - 1]
        if (!last) {
          lassoRef.current = [point]
          return
        }
        const box = imageRef.current!.getBoundingClientRect()
        if (Math.hypot((point.x - last.x) * box.width, (point.y - last.y) * box.height) >= 2) {
          // Keep long touch gestures bounded without allocating a copy each frame.
          if (path.length >= 2048) lassoRef.current = path.filter((_, index) => index % 2 === 0)
          lassoRef.current.push(point)
          redrawPreview()
        }
      } else if (pointer.tool === 'rectangle') {
        const first = pointer.start!
        lassoRef.current = [first, { x: point.x, y: first.y }, point, { x: first.x, y: point.y }]
        redrawPreview()
      } else {
        pointer.points!.push(point)
        paint(pointer.last, point, pointer.tool)
      }
    }
    if (action === 'crop' && pointer.start) {
      const x = Math.min(pointer.start.x, point.x)
      const y = Math.min(pointer.start.y, point.y)
      setCrop({
        x,
        y,
        width: Math.abs(point.x - pointer.start.x),
        height: Math.abs(point.y - pointer.start.y),
      })
    }
    pointer.last = point
  }

  const stop = (event: PointerEvent<HTMLDivElement>) => {
    const pointer = pointerRef.current
    if (pointer?.id !== event.pointerId) return
    setDrawing(false)
    if (marked && pointer.tool !== 'pan') {
      const canvas = maskRef.current
      const context = canvas?.getContext('2d')
      if (canvas && context) {
        if (event.type !== 'pointerup') {
          if (pointer.before) context.putImageData(pointer.before, 0, 0)
        } else if (lassoRef.current.length) {
          const points = lassoRef.current.map((point) => ({
            x: point.x * canvas.width,
            y: point.y * canvas.height,
          }))
          if (isUsableMaskLasso(points)) {
            rememberMask()
            fillMaskLasso(context, points, false)
            const mark: Mark = {
              id: nextMarkRef.current++,
              tool: pointer.tool as 'rectangle' | 'lasso',
              points: [...lassoRef.current],
              width: 0,
            }
            marksRef.current = [...marksRef.current, mark]
            setMarks(marksRef.current)
          }
        } else if (pointer.before) {
          rememberMask(pointer.before)
          marksRef.current = [
            ...marksRef.current,
            {
              id: nextMarkRef.current++,
              tool: pointer.tool as 'brush' | 'eraser',
              points: pointer.points!,
              width: pointer.width!,
            },
          ]
          setMarks(marksRef.current)
        }
        lassoRef.current = []
        redrawPreview()
      }
      syncMarkPresent()
    }
    if (
      action === 'crop' &&
      pointer.start &&
      (Math.abs(pointer.last.x - pointer.start.x) < 0.05 ||
        Math.abs(pointer.last.y - pointer.start.y) < 0.05)
    )
      setCrop(DEFAULT_CROP)
    pointerRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const restore = (direction: 'undo' | 'redo') => {
    if (pointerRef.current) return
    const canvas = maskRef.current
    const context = canvas?.getContext('2d', { willReadFrequently: true })
    if (!canvas || !context) return
    const from = direction === 'undo' ? undoRef.current : redoRef.current
    const to = direction === 'undo' ? redoRef.current : undoRef.current
    const previous = from.pop()
    if (!previous) return
    to.push({
      pixels: context.getImageData(0, 0, canvas.width, canvas.height),
      marks: marksRef.current,
    })
    marksRef.current = previous.marks
    setMarks(marksRef.current)
    context.putImageData(previous.pixels, 0, 0)
    setCanUndo(undoRef.current.length > 0)
    setCanRedo(redoRef.current.length > 0)
    redrawPreview()
    syncMarkPresent()
  }

  const removeRegion = (id: number) => {
    if (pointerRef.current || busy) return
    const canvas = maskRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    rememberMask()
    marksRef.current = marksRef.current.filter((mark) => mark.id !== id)
    setMarks(marksRef.current)
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    for (const mark of marksRef.current) {
      const points = mark.points.map((point) => ({
        x: point.x * canvas.width,
        y: point.y * canvas.height,
      }))
      if (mark.tool === 'rectangle' || mark.tool === 'lasso') fillMaskLasso(context, points, false)
      else {
        context.save()
        context.globalCompositeOperation =
          mark.tool === 'eraser' ? 'source-over' : 'destination-out'
        context.strokeStyle = context.fillStyle = '#fff'
        context.lineWidth = mark.width
        context.lineCap = context.lineJoin = 'round'
        context.beginPath()
        context.moveTo(points[0]!.x, points[0]!.y)
        for (const point of points) context.lineTo(point.x, point.y)
        context.stroke()
        for (const point of points) {
          context.beginPath()
          context.arc(point.x, point.y, mark.width / 2, 0, Math.PI * 2)
          context.fill()
        }
        context.restore()
      }
    }
    redrawPreview()
    syncMarkPresent()
  }
  const regions = marks.filter((mark) => mark.tool === 'rectangle' || mark.tool === 'lasso')

  const generate = () => {
    const image = imageRef.current
    if (!image || !working || busy || !ready || pointerRef.current) return
    try {
      let input: ArtifactEditInput
      if (marked)
        input = {
          ...exportMarkedImage(working, maskRef.current!, image),
          regions: regions.map(markBounds),
        }
      else if (action === 'crop') input = cropImage(image, crop)
      else input = extendImage(image, extension)
      onGenerate(input, instruction.trim())
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  return (
    <Overlay onClose={busy ? () => {} : onClose} tier="artifact" layout="center">
      <div
        ref={dialogRef}
        className="studio-artifact-edit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="artifact-edit-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Tab') {
            const items = [
              ...event.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled), textarea, [role="slider"]:not([aria-disabled="true"])',
              ),
            ]
            const first = items[0],
              last = items[items.length - 1]
            if (
              event.shiftKey &&
              (document.activeElement === first || document.activeElement === event.currentTarget)
            ) {
              event.preventDefault()
              last?.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault()
              first?.focus()
            }
          }
          if (event.target instanceof HTMLTextAreaElement || !marked) return
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
            event.preventDefault()
            event.stopPropagation()
            if (!busy) restore(event.shiftKey ? 'redo' : 'undo')
          }
        }}
      >
        <header>
          <h2 id="artifact-edit-title">{t(`tool.${action}`)}</h2>
          <Button
            variant="ghost"
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={t('tool.closePreview')}
          >
            <X size={22} />
          </Button>
        </header>
        <div ref={stageRef} className="studio-artifact-edit-stage">
          {loading && <span role="status">{t('tool.loadingPreview')}</span>}
          {working && (
            <div
              className="studio-artifact-edit-image"
              data-action={action}
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                width: imageSize.x
                  ? Math.min(
                      stageSize.x / (action === 'outpaint' ? 1 + extension * 2 : 1),
                      (stageSize.y * imageSize.x) /
                        imageSize.y /
                        (action === 'outpaint' ? 1 + extension * 2 : 1),
                    )
                  : undefined,
                aspectRatio: imageSize.x ? `${imageSize.x} / ${imageSize.y}` : undefined,
              }}
            >
              <img ref={imageRef} src={working} alt="" onLoad={initializeMask} draggable={false} />
              {marked && <canvas ref={previewRef} aria-hidden="true" />}
              {regions.map((region, index) => {
                const bounds = markBounds(region)
                return (
                  <div
                    key={region.id}
                    className="studio-artifact-edit-region"
                    style={{
                      left: `${bounds.x * 100}%`,
                      top: `${bounds.y * 100}%`,
                      width: `${bounds.width * 100}%`,
                      height: `${bounds.height * 100}%`,
                    }}
                  >
                    <span>{index + 1}</span>
                  </div>
                )
              })}
              {marked && <canvas ref={maskRef} hidden aria-hidden="true" />}
              {action === 'crop' && (
                <div
                  className="studio-artifact-edit-crop"
                  style={{
                    left: `${crop.x * 100}%`,
                    top: `${crop.y * 100}%`,
                    width: `${crop.width * 100}%`,
                    height: `${crop.height * 100}%`,
                  }}
                />
              )}
              {action === 'outpaint' && (
                <div
                  className="studio-artifact-edit-outpaint"
                  style={{ inset: `${-extension * 100}%` }}
                />
              )}
              {cursor && marked && (tool === 'brush' || tool === 'eraser') && (
                <div
                  className="studio-artifact-edit-cursor"
                  style={{
                    left: `${cursor.x * 100}%`,
                    top: `${cursor.y * 100}%`,
                    width: brush / zoom,
                    height: brush / zoom,
                  }}
                />
              )}
              <div
                className="studio-artifact-edit-hit"
                data-tool={tool}
                onPointerLeave={() => setCursor(null)}
                onPointerDown={start}
                onPointerMove={move}
                onPointerUp={stop}
                onPointerCancel={stop}
              />
            </div>
          )}
          {marked && working && (
            <div className="studio-artifact-edit-toolbar">
              <Button
                type="button"
                variant="ghost"
                disabled={busy || drawing}
                aria-label={t('tool.markLasso')}
                title={t('tool.markLasso')}
                aria-pressed={tool === 'lasso'}
                onClick={() => setTool('lasso')}
              >
                <Lasso size={18} />
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy || drawing}
                aria-label={t('tool.markRectangle')}
                title={t('tool.markRectangle')}
                aria-pressed={tool === 'rectangle'}
                onClick={() => setTool('rectangle')}
              >
                <Square size={18} />
              </Button>
              <Button
                variant="ghost"
                type="button"
                disabled={busy || drawing}
                aria-label={t('tool.markBrush')}
                title={t('tool.markBrush')}
                aria-pressed={tool === 'brush'}
                onClick={() => setTool('brush')}
              >
                <Brush size={18} />
              </Button>
              <Button
                variant="ghost"
                type="button"
                disabled={busy || drawing}
                aria-label={t('tool.markEraser')}
                title={t('tool.markEraser')}
                aria-pressed={tool === 'eraser'}
                onClick={() => setTool('eraser')}
              >
                <Eraser size={18} />
              </Button>
              <Button
                variant="ghost"
                type="button"
                disabled={busy || drawing}
                aria-label={t('tool.panImage')}
                title={t('tool.panImage')}
                aria-pressed={tool === 'pan'}
                onClick={() => setTool('pan')}
              >
                <Hand size={18} />
              </Button>
              <span className="studio-artifact-edit-tool-divider" />
              <Button
                variant="ghost"
                type="button"
                aria-label={t('tool.undoMark')}
                onClick={() => restore('undo')}
                disabled={!canUndo || busy || drawing}
              >
                <Undo2 size={18} />
              </Button>
              <Button
                variant="ghost"
                type="button"
                aria-label={t('tool.redoMark')}
                onClick={() => restore('redo')}
                disabled={!canRedo || busy || drawing}
              >
                <Redo2 size={18} />
              </Button>
              <Button
                type="button"
                variant="ghost"
                aria-label={t('tool.clearMark')}
                title={t('tool.clearMark')}
                disabled={!markPresent || busy || drawing}
                onClick={() => {
                  if (pointerRef.current) return
                  const canvas = maskRef.current
                  const context = canvas?.getContext('2d')
                  if (!canvas || !context) return
                  rememberMask()
                  marksRef.current = []
                  setMarks([])
                  context.fillStyle = '#fff'
                  context.fillRect(0, 0, canvas.width, canvas.height)
                  redrawPreview()
                  syncMarkPresent()
                }}
              >
                <Trash2 size={18} />
              </Button>
              <label>
                <span>{t('tool.brushSize')}</span>
                <Slider
                  aria-label={t('tool.brushSize')}
                  min={10}
                  max={150}
                  value={[brush]}
                  onValueChange={([value]) => setBrush(value)}
                  disabled={busy || drawing || (tool !== 'brush' && tool !== 'eraser')}
                  className="w-20"
                />
              </label>
            </div>
          )}
          {action === 'crop' && (
            <div className="studio-artifact-edit-hint">
              <Crop size={15} />
              {t('tool.cropHint')}
            </div>
          )}
          {action === 'outpaint' && (
            <div className="studio-artifact-edit-toolbar studio-artifact-edit-extension">
              <span>{t('tool.extendBy')}</span>
              {[0.15, 0.25, 0.4].map((value) => (
                <Button
                  variant="ghost"
                  type="button"
                  key={value}
                  aria-pressed={extension === value}
                  onClick={() => setExtension(value)}
                >
                  {Math.round(value * 100)}%
                </Button>
              ))}
            </div>
          )}
          {marked && (
            <div className="studio-artifact-edit-zoom">
              <Button
                variant="ghost"
                type="button"
                disabled={busy || drawing}
                aria-label={t('tool.zoomOut')}
                onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
              >
                <Minus size={16} />
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy || drawing}
                aria-label={t('tool.fitImage')}
                title={t('tool.fitImage')}
                onClick={() => {
                  setZoom(1)
                  setPan({ x: 0, y: 0 })
                }}
              >
                <Maximize size={16} />
              </Button>
              <span>{Math.round(zoom * 100)}%</span>
              <Button
                variant="ghost"
                type="button"
                disabled={busy || drawing}
                aria-label={t('tool.zoomIn')}
                onClick={() => setZoom((value) => Math.min(3, value + 0.25))}
              >
                <Plus size={16} />
              </Button>
            </div>
          )}
        </div>
        <div className="studio-artifact-edit-composer">
          {regions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {regions.map((region, index) => (
                <Button
                  key={region.id}
                  variant="outline"
                  size="sm"
                  disabled={busy || drawing}
                  onClick={() => removeRegion(region.id)}
                  aria-label={t('tool.removeRegion', { number: index + 1 })}
                >
                  {t('tool.region', { number: index + 1 })}
                  <X size={14} />
                </Button>
              ))}
            </div>
          )}
          <textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder={t(`tool.${action}Placeholder`)}
            aria-label={t('tool.editInstruction')}
            rows={2}
            maxLength={2000}
          />
          <div>
            <span>
              {marked
                ? t('tool.markHint')
                : action === 'outpaint'
                  ? t('tool.outpaintHint')
                  : t('tool.cropHint')}
            </span>
            <Button
              variant="ghost"
              type="button"
              onClick={generate}
              disabled={
                busy ||
                drawing ||
                loading ||
                !working ||
                !ready ||
                (marked && (!markPresent || (action === 'inpaint' && !instruction.trim())))
              }
            >
              {busy ? t('tool.submittingEdit') : t('tool.generateEdit')}
            </Button>
          </div>
        </div>
      </div>
    </Overlay>
  )
}
