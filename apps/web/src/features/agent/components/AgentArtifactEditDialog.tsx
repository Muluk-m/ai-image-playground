import { Brush, Crop, Eraser, Hand, Minus, Plus, Redo2, Undo2, X } from 'lucide-react'
import { type PointerEvent, useEffect, useRef, useState } from 'react'
import Overlay from '../../../components/Overlay'
import { useTranslation } from '../../../i18n'
import { classifyMaskAlpha } from '../../../lib/mask'
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

type MarkTool = 'brush' | 'eraser' | 'pan'
type Point = { x: number; y: number }
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
  const imageRef = useRef<HTMLImageElement>(null)
  const maskRef = useRef<HTMLCanvasElement>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)
  const pointerRef = useRef<{ id: number; last: Point; start?: Point; pan?: Point } | null>(null)
  const undoRef = useRef<ImageData[]>([])
  const redoRef = useRef<ImageData[]>([])
  const [working, setWorking] = useState('')
  const [loading, setLoading] = useState(true)
  const [instruction, setInstruction] = useState('')
  const [tool, setTool] = useState<MarkTool>('brush')
  const [brush, setBrush] = useState(36)
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

  const redrawPreview = () => {
    const mask = maskRef.current
    const preview = previewRef.current
    const context = preview?.getContext('2d')
    if (!mask || !preview || !context) return
    context.clearRect(0, 0, preview.width, preview.height)
    context.save()
    context.fillStyle = 'rgba(173, 220, 126, .42)'
    context.fillRect(0, 0, preview.width, preview.height)
    context.globalCompositeOperation = 'destination-out'
    context.drawImage(mask, 0, 0)
    context.restore()
  }

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
    if (!image || !mask || !preview || !image.naturalWidth) return
    mask.width = preview.width = image.naturalWidth
    mask.height = preview.height = image.naturalHeight
    const context = mask.getContext('2d')
    if (!context) return
    context.fillStyle = '#fff'
    context.fillRect(0, 0, mask.width, mask.height)
    undoRef.current = []
    redoRef.current = []
    setCanUndo(false)
    setCanRedo(false)
    setMarkPresent(false)
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

  const rememberMask = () => {
    const canvas = maskRef.current
    const context = canvas?.getContext('2d', { willReadFrequently: true })
    if (!canvas || !context) return
    undoRef.current.push(context.getImageData(0, 0, canvas.width, canvas.height))
    // Bound full-resolution history to 32 MiB, including the snapshots moved to redo.
    const limit = Math.max(
      1,
      Math.min(20, Math.floor((32 * 1024 * 1024) / (canvas.width * canvas.height * 4))),
    )
    while (undoRef.current.length > limit) undoRef.current.shift()
    redoRef.current = []
    setCanUndo(true)
    setCanRedo(false)
  }

  const paint = (from: Point, to: Point) => {
    const canvas = maskRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    context.save()
    context.globalCompositeOperation = tool === 'eraser' ? 'source-over' : 'destination-out'
    context.strokeStyle = '#fff'
    context.fillStyle = '#fff'
    context.lineWidth = Math.max(4, (brush / 1000) * Math.min(canvas.width, canvas.height))
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
    if (busy || !working) return
    const point = pointOnImage(event)
    if (!point) return
    event.currentTarget.setPointerCapture(event.pointerId)
    pointerRef.current = {
      id: event.pointerId,
      last: point,
      start: point,
      pan: { x: event.clientX - pan.x, y: event.clientY - pan.y },
    }
    if (marked && tool !== 'pan') {
      rememberMask()
      paint(point, point)
    }
  }

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const pointer = pointerRef.current
    if (!pointer || pointer.id !== event.pointerId) return
    if (tool === 'pan' && marked) {
      setPan({ x: event.clientX - pointer.pan!.x, y: event.clientY - pointer.pan!.y })
      return
    }
    const point = pointOnImage(event)
    if (!point) return
    if (marked) paint(pointer.last, point)
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
    if (marked && tool !== 'pan') syncMarkPresent()
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
    const canvas = maskRef.current
    const context = canvas?.getContext('2d', { willReadFrequently: true })
    if (!canvas || !context) return
    const from = direction === 'undo' ? undoRef.current : redoRef.current
    const to = direction === 'undo' ? redoRef.current : undoRef.current
    const previous = from.pop()
    if (!previous) return
    to.push(context.getImageData(0, 0, canvas.width, canvas.height))
    context.putImageData(previous, 0, 0)
    setCanUndo(undoRef.current.length > 0)
    setCanRedo(redoRef.current.length > 0)
    redrawPreview()
    syncMarkPresent()
  }

  const generate = () => {
    const image = imageRef.current
    if (!image || !working || busy) return
    try {
      let input: ArtifactEditInput
      if (marked) input = exportMarkedImage(working, maskRef.current!)
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
      >
        <header>
          <h2 id="artifact-edit-title">{t(`tool.${action}`)}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={t('tool.closePreview')}
          >
            <X size={22} />
          </button>
        </header>
        <div className="studio-artifact-edit-stage">
          {loading && <span role="status">{t('tool.loadingPreview')}</span>}
          {working && (
            <div
              className="studio-artifact-edit-image"
              data-action={action}
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                width: action === 'outpaint' ? `${100 / (1 + extension * 2)}%` : undefined,
              }}
            >
              <img ref={imageRef} src={working} alt="" onLoad={initializeMask} draggable={false} />
              {marked && <canvas ref={previewRef} aria-hidden="true" />}
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
              <div
                className="studio-artifact-edit-hit"
                onPointerDown={start}
                onPointerMove={move}
                onPointerUp={stop}
                onPointerCancel={stop}
              />
            </div>
          )}
          {marked && working && (
            <div className="studio-artifact-edit-toolbar">
              <button
                type="button"
                aria-label={t('tool.markBrush')}
                title={t('tool.markBrush')}
                aria-pressed={tool === 'brush'}
                onClick={() => setTool('brush')}
              >
                <Brush size={18} />
              </button>
              <button
                type="button"
                aria-label={t('tool.markEraser')}
                title={t('tool.markEraser')}
                aria-pressed={tool === 'eraser'}
                onClick={() => setTool('eraser')}
              >
                <Eraser size={18} />
              </button>
              <button
                type="button"
                aria-label={t('tool.panImage')}
                title={t('tool.panImage')}
                aria-pressed={tool === 'pan'}
                onClick={() => setTool('pan')}
              >
                <Hand size={18} />
              </button>
              <span className="studio-artifact-edit-tool-divider" />
              <button
                type="button"
                aria-label={t('tool.undoMark')}
                onClick={() => restore('undo')}
                disabled={!canUndo}
              >
                <Undo2 size={18} />
              </button>
              <button
                type="button"
                aria-label={t('tool.redoMark')}
                onClick={() => restore('redo')}
                disabled={!canRedo}
              >
                <Redo2 size={18} />
              </button>
              <label>
                <span>{t('tool.brushSize')}</span>
                <input
                  type="range"
                  min="10"
                  max="150"
                  value={brush}
                  onChange={(event) => setBrush(Number(event.target.value))}
                  disabled={tool === 'pan'}
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
                <button
                  type="button"
                  key={value}
                  aria-pressed={extension === value}
                  onClick={() => setExtension(value)}
                >
                  {Math.round(value * 100)}%
                </button>
              ))}
            </div>
          )}
          {marked && (
            <div className="studio-artifact-edit-zoom">
              <button
                type="button"
                aria-label={t('tool.zoomOut')}
                onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
              >
                <Minus size={16} />
              </button>
              <span>{Math.round(zoom * 100)}%</span>
              <button
                type="button"
                aria-label={t('tool.zoomIn')}
                onClick={() => setZoom((value) => Math.min(3, value + 0.25))}
              >
                <Plus size={16} />
              </button>
            </div>
          )}
        </div>
        <div className="studio-artifact-edit-composer">
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
            <button
              type="button"
              onClick={generate}
              disabled={busy || loading || !working || (marked && !markPresent)}
            >
              {busy ? t('tool.submittingEdit') : t('tool.generateEdit')}
            </button>
          </div>
        </div>
      </div>
    </Overlay>
  )
}
