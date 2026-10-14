import type Konva from 'konva'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Image as KImage, Layer, Stage } from 'react-konva'
import Overlay from '../../../components/patterns/Overlay'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Input } from '../../../components/ui/input'
import { Slider } from '../../../components/ui/slider'
import { Textarea } from '../../../components/ui/textarea'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import type { CanvasEditor } from '../lib/editor'
import type { NodeCanvasDocument } from '../lib/nodeCanvasDocument'
import {
  finishNodeImageEdit,
  type ImageEditMode,
  type ImageEditStroke,
  type NodeImageEditSource,
  openNodeImageEdit,
  renderImageEditStrokes,
} from '../lib/nodeImageEdit'
import { inpaintRefusal } from '../lib/submitInpaint'

export default function NodeImageEditor({
  editor,
  canvas,
  nodeId,
  onClose,
}: {
  editor: CanvasEditor
  canvas: NodeCanvasDocument
  nodeId: string
  onClose: () => void
}) {
  const { t } = useTranslation('canvas')
  const [source, setSource] = useState<NodeImageEditSource | null>(null)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<ImageEditMode>('annotate')
  const [tool, setTool] = useState<'brush' | 'eraser' | 'rect'>('brush')
  const [color, setColor] = useState('#ef4444')
  const [width, setWidth] = useState(12)
  const [strokes, setStrokes] = useState<ImageEditStroke[]>([])
  const [redo, setRedo] = useState<ImageEditStroke[]>([])
  const [active, setActive] = useState<ImageEditStroke | null>(null)
  const activeRef = useRef<ImageEditStroke | null>(null)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const stage = useRef<Konva.Stage>(null)
  const paintLayer = useRef<Konva.Layer>(null)
  const previewCanvas = useMemo(() => document.createElement('canvas'), [])
  const host = useRef<HTMLDivElement>(null)
  const [bounds, setBounds] = useState({ width: 640, height: 400 })
  const settings = useStore((s) => s.settings)
  const refusal = source ? inpaintRefusal(source.element, source.element, settings) : null
  useEffect(() => {
    let alive = true
    void openNodeImageEdit(editor, canvas, nodeId)
      .then((value) => {
        if (alive) setSource(value)
      })
      .catch((reason) => {
        if (alive) setError(String(reason.message ?? reason))
      })
    return () => {
      alive = false
    }
  }, [editor, canvas, nodeId])
  useEffect(() => {
    if (!host.current) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setBounds({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(host.current)
    return () => observer.disconnect()
  }, [])
  const scale = source
    ? Math.max(
        0.001,
        Math.min(
          (bounds.width - 24) / source.element.width,
          (bounds.height - 24) / source.element.height,
          1,
        ),
      )
    : 1
  const offset = source
    ? {
        x: (bounds.width - source.element.width * scale) / 2,
        y: (bounds.height - source.element.height * scale) / 2,
      }
    : { x: 0, y: 0 }
  const overlay = useMemo(
    () =>
      source
        ? renderImageEditStrokes(
            source.element,
            [...strokes, ...(active ? [active] : [])],
            mode === 'inpaint',
            previewCanvas,
            scale,
          )
        : null,
    [source, strokes, active, mode, previewCanvas, scale],
  )
  useEffect(() => {
    paintLayer.current?.batchDraw()
  }, [strokes, active, source, mode, scale])
  const modeLabels = {
    inpaint: t('pixelEdit.inpaint'),
    annotate: t('pixelEdit.annotate'),
    draw: t('pixelEdit.draw'),
  }
  const toolLabels = {
    brush: t('pixelEdit.brush'),
    eraser: t('pixelEdit.eraser'),
    rect: t('pixelEdit.rect'),
  }
  const hints = {
    inpaint: t('pixelEdit.inpaintHint'),
    annotate: t('pixelEdit.annotateHint'),
    draw: t('pixelEdit.drawHint'),
  }
  function point() {
    const position = stage.current?.getPointerPosition()
    if (!position || !source) return null
    return {
      x: Math.max(0, Math.min(source.element.width, (position.x - offset.x) / scale)),
      y: Math.max(0, Math.min(source.element.height, (position.y - offset.y) / scale)),
    }
  }
  function begin() {
    const p = point()
    if (!p || busy) return
    const stroke: ImageEditStroke = {
      tool: tool === 'eraser' ? 'eraser' : 'brush',
      shape: tool === 'rect' ? 'rect' : undefined,
      points: [p],
      width,
      color,
    }
    activeRef.current = stroke
    setActive(stroke)
    setRedo([])
  }
  function move() {
    const p = point()
    const previous = activeRef.current
    if (!p || !previous) return
    const next = {
      ...previous,
      points: previous.shape === 'rect' ? [previous.points[0]!, p] : [...previous.points, p],
    }
    activeRef.current = next
    setActive(next)
  }
  function end() {
    const stroke = activeRef.current
    if (stroke) setStrokes((previous) => [...previous, stroke])
    activeRef.current = null
    setActive(null)
  }
  async function submit() {
    if (!source || running.current) return
    running.current = true
    setBusy(true)
    setError('')
    try {
      if (await finishNodeImageEdit(editor, canvas, source, mode, strokes, prompt.trim())) onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  return (
    <Overlay
      onClose={() => {
        if (!running.current) onClose()
      }}
      layout="fill"
      label={t('pixelEdit.title')}
    >
      <div className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Icon name="brush" />
            <h2 className="truncate text-sm font-semibold">{t('pixelEdit.title')}</h2>
          </div>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            {t('pixelEdit.close')}
          </Button>
        </header>
        <div
          className="flex shrink-0 flex-wrap items-center justify-center gap-1 border-b border-border p-2"
          role="group"
          aria-label={t('pixelEdit.mode')}
        >
          {(['inpaint', 'annotate', 'draw'] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={mode === value ? 'secondary' : 'ghost'}
              aria-pressed={mode === value}
              disabled={busy}
              onClick={() => {
                end()
                setMode(value)
              }}
            >
              {modeLabels[value]}
            </Button>
          ))}
        </div>
        <div
          className="flex shrink-0 flex-wrap items-center justify-center gap-2 px-3 py-2"
          role="group"
          aria-label={t('pixelEdit.tools')}
        >
          {(['brush', 'eraser', 'rect'] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={tool === value ? 'secondary' : 'ghost'}
              aria-pressed={tool === value}
              disabled={busy}
              onClick={() => setTool(value)}
            >
              {toolLabels[value]}
            </Button>
          ))}
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            {t('pixelEdit.width')}
            <Slider
              aria-label={t('pixelEdit.width')}
              min={1}
              max={120}
              value={[width]}
              disabled={busy}
              onValueChange={([value]) => setWidth(value ?? 12)}
              className="w-24 accent-primary"
            />
            <span className="w-5 tabular-nums">{width}</span>
          </label>
          {mode !== 'inpaint' && (
            <Input
              type="color"
              aria-label={t('pixelEdit.color')}
              value={color}
              disabled={busy}
              onChange={(e) => setColor(e.target.value)}
              className="h-8 w-8 rounded border border-border bg-transparent p-1"
            />
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={!strokes.length || busy}
            onClick={() => {
              setRedo((previous) => [...previous, strokes[strokes.length - 1]!])
              setStrokes((previous) => previous.slice(0, -1))
            }}
          >
            {t('nodes.undo')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!redo.length || busy}
            onClick={() => {
              setStrokes((previous) => [...previous, redo[redo.length - 1]!])
              setRedo((previous) => previous.slice(0, -1))
            }}
          >
            {t('nodes.redo')}
          </Button>
        </div>
        <div
          ref={host}
          className="min-h-0 flex-1 overflow-hidden bg-muted/30"
          style={{ touchAction: 'none' }}
        >
          {source && (
            <Stage
              ref={stage}
              width={bounds.width}
              height={bounds.height}
              onPointerDown={begin}
              onPointerMove={move}
              onPointerUp={end}
              onPointerCancel={end}
              onPointerLeave={end}
            >
              <Layer
                ref={paintLayer}
                listening={false}
                x={offset.x}
                y={offset.y}
                scaleX={scale}
                scaleY={scale}
              >
                <KImage
                  image={source.image}
                  width={source.element.width}
                  height={source.element.height}
                />
                {overlay && (
                  <KImage
                    image={overlay}
                    width={source.element.width}
                    height={source.element.height}
                    opacity={mode === 'inpaint' ? 0.5 : 1}
                  />
                )}
              </Layer>
            </Stage>
          )}
        </div>
        <footer className="shrink-0 space-y-2 border-t border-border bg-card p-3 sm:px-6">
          <p className="text-xs text-muted-foreground">{hints[mode]}</p>
          {mode !== 'draw' && (
            <Textarea
              aria-label={t('pixelEdit.prompt')}
              placeholder={t('pixelEdit.prompt')}
              value={prompt}
              disabled={busy}
              onChange={(e) => setPrompt(e.target.value)}
              rows={2}
              className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          )}
          {(error || (mode === 'inpaint' && refusal)) && (
            <p role="alert" className="text-xs text-destructive">
              {error || refusal}
            </p>
          )}
          <div className="flex justify-end">
            <Button
              disabled={
                !source ||
                !strokes.length ||
                busy ||
                (mode !== 'draw' && !prompt.trim()) ||
                (mode === 'inpaint' && !!refusal)
              }
              onClick={() => void submit()}
            >
              {busy
                ? t('pixelEdit.saving')
                : mode === 'draw'
                  ? t('pixelEdit.save')
                  : t('pixelEdit.generate')}
            </Button>
          </div>
        </footer>
      </div>
    </Overlay>
  )
}
