import { type ReactNode, useEffect, useRef, useState } from 'react'
import { TooltipIconButton } from '../../components/assistant-ui/elements/tooltip-icon-button'
import { Button } from '../../components/ui/button'
import { Icon } from '../../components/ui/icon'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select'
import { Slider } from '../../components/ui/slider'
import { useTranslation } from '../../i18n'
import { cn } from '../../lib/utils'
import { CanvasLimitError } from '../toolbox/lib/canvasLimits'
import { downloadImages } from '../toolbox/lib/deliver'
import { formatLabel } from '../toolbox/lib/encode'
import { type ExportSettings, type ExportSource, exportSize, prepareExports } from './export'

type Axis = 'width' | 'height'

const formats = ['image/png', 'image/jpeg', 'image/webp', 'image/avif'] as const
const FIELD = 'h-9 rounded-lg border-transparent bg-muted shadow-none'
const ICON_BUTTON =
  'size-9 shrink-0 rounded-lg bg-muted text-muted-foreground hover:text-foreground'

export default function ExportForm({
  sources,
  name = 'images',
  onBusyChange,
}: {
  sources: readonly ExportSource[]
  name?: string
  onBusyChange?: (busy: boolean) => void
}) {
  const { t } = useTranslation('toolbox')
  const axisLabels = { width: t('export.width'), height: t('export.height') }
  const [settings, setSettings] = useState<ExportSettings>({
    mode: 'original',
    value: 100,
    quality: 92,
    rows: [{ id: crypto.randomUUID(), scale: 1, format: 'image/png' }],
  })
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [done, setDone] = useState(0)
  const [sizeDraft, setSizeDraft] = useState<Partial<Record<Axis, string>>>({})
  const lastAxis = useRef<Axis>('width')
  const abort = useRef<AbortController | null>(null)
  // 单张时读尺寸已经拿到原图，导出直接复用，不再下载第二遍。
  const firstBlob = useRef<Blob | null>(null)
  const single = sources.length === 1 && sources[0]?.media === 'image'
  const first = sources[0]
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    let alive = true
    let url: string | null = null
    const controller = new AbortController()
    firstBlob.current = null
    setDimensions(null)
    setPreview(null)
    setError('')
    setDone(0)
    setSizeDraft({})
    setLoading(false)
    if (!single || !first) return
    setLoading(true)
    void first
      .load(controller.signal)
      .then(async (blob) => {
        const bitmap = await createImageBitmap(blob)
        if (alive) {
          firstBlob.current = blob
          setDimensions({ width: bitmap.width, height: bitmap.height })
          url = URL.createObjectURL?.(blob) ?? null
          setPreview(url)
        }
        bitmap.close()
      })
      .catch(() => {
        if (alive) setError(t('export.originalFailed'))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
      controller.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [single, first, t])
  useEffect(() => () => abort.current?.abort(), [])
  useEffect(() => {
    onBusyChange?.(progress !== null)
  }, [progress, onBusyChange])
  const images = sources.filter((one) => one.media === 'image').length
  const count = images * settings.rows.length + sources.length - images
  const busy = progress !== null
  const locked = settings.stretch === undefined
  const imageSources = sources.filter((source) => source.media === 'image')
  const originals = imageSources.map((source) => {
    if (single) return dimensions
    if (source.width && source.height) return { width: source.width, height: source.height }
    return null
  })
  const outputSizes = (scale: number) =>
    originals.map((original) =>
      original
        ? exportSize(
            original.width,
            original.height,
            settings.mode,
            settings.value,
            scale,
            settings.stretch,
          )
        : null,
    )
  const sizes = outputSizes(1)
  const sharedAxis = (axis: Axis, outputs = sizes) => {
    const value = outputs[0]?.[axis]
    return value !== undefined && outputs.every((output) => output?.[axis] === value) ? value : null
  }
  const fieldValue = (axis: Axis) =>
    sizeDraft[axis] ??
    settings.stretch?.[axis] ??
    (settings.mode === axis ? settings.value : sharedAxis(axis)) ??
    ''
  const validSize = (text: string) =>
    text.trim() !== '' && Number.isInteger(Number(text)) && Number(text) > 0
  const invalid = Object.values(sizeDraft).some((text) => !validSize(text))
  let sizeHint = t('export.ratioUnlocked')
  if (invalid) sizeHint = t('export.invalidSize')
  else if (locked) sizeHint = t('export.ratioLocked')
  const changeSize = (axis: Axis, text: string) => {
    setSizeDraft((prev) => (locked ? { [axis]: text } : { ...prev, [axis]: text }))
    setDone(0)
    if (!validSize(text)) return
    lastAxis.current = axis
    setSettings((prev) =>
      locked
        ? { ...prev, mode: axis, value: Number(text) }
        : { ...prev, stretch: { ...prev.stretch, [axis]: Number(text) } },
    )
  }
  const toggleLock = () => {
    if (invalid) return
    const axis = lastAxis.current
    const value = Number(fieldValue(axis))
    setSizeDraft({})
    setDone(0)
    setSettings((prev) =>
      locked
        ? { ...prev, stretch: {} }
        : { ...prev, stretch: undefined, ...(value > 0 ? { mode: axis, value } : {}) },
    )
  }
  const resetSize = () => {
    setSizeDraft({})
    setDone(0)
    setSettings((prev) => ({
      ...prev,
      mode: 'original',
      value: 100,
      stretch: locked ? undefined : {},
    }))
  }
  const updateRow = (id: string, patch: Partial<ExportSettings['rows'][number]>) =>
    setSettings((prev) => ({
      ...prev,
      rows: prev.rows.map((one) => (one.id === id ? { ...one, ...patch } : one)),
    }))
  const run = async () => {
    const controller = new AbortController()
    abort.current = controller
    setError('')
    setDone(0)
    setProgress(0)
    try {
      const cached = firstBlob.current
      const inputs = single && cached && first ? [{ ...first, load: async () => cached }] : sources
      const files = await prepareExports(inputs, settings, controller.signal, setProgress)
      controller.signal.throwIfAborted()
      await downloadImages(files, `${name}.zip`, controller.signal)
      if (!controller.signal.aborted) setDone(files.length)
    } catch (err) {
      if (!controller.signal.aborted)
        setError(
          err instanceof CanvasLimitError
            ? t('export.limit', { width: err.width, height: err.height })
            : t('export.failed'),
        )
    } finally {
      if (!controller.signal.aborted) setProgress(null)
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
        <div className="flex items-center gap-3">
          <div className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
            {single && preview ? (
              <img src={preview} alt="" className="size-full object-cover" />
            ) : (
              <Icon name="images" size="md" />
            )}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {single ? first?.name : t('export.selected', { count: sources.length })}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
              {loading
                ? t('export.loading')
                : dimensions
                  ? `${dimensions.width} × ${dimensions.height}`
                  : !single && t(locked ? 'export.batchHint' : 'export.ratioUnlocked')}
            </p>
          </div>
        </div>
        {images > 0 && (
          <fieldset disabled={busy} className="space-y-6">
            <Section
              title={t('export.size')}
              action={
                <Button variant="ghost" size="xs" onClick={resetSize}>
                  {t('export.reset')}
                </Button>
              }
            >
              <div className="flex items-end gap-2">
                {(['width', 'height'] as const).map((axis) => (
                  <div key={axis} className="min-w-0 flex-1 space-y-2">
                    <Label htmlFor={`export-${axis}`} className="text-xs text-muted-foreground">
                      {axisLabels[axis]} <span className="font-normal">px</span>
                    </Label>
                    <Input
                      id={`export-${axis}`}
                      type="number"
                      min={1}
                      step={1}
                      className="tabular-nums"
                      aria-label={axisLabels[axis]}
                      placeholder={t('export.multipleValues')}
                      value={fieldValue(axis)}
                      disabled={single && !dimensions}
                      onChange={(event) => changeSize(axis, event.target.value)}
                      aria-invalid={sizeDraft[axis] !== undefined && !validSize(sizeDraft[axis])}
                    />
                  </div>
                ))}
                <TooltipIconButton
                  className={cn('size-9', locked && 'text-primary bg-accent')}
                  tooltip={t(locked ? 'export.ratioUnlock' : 'export.ratioLock')}
                  aria-pressed={locked}
                  disabled={invalid || (single && !dimensions)}
                  onClick={toggleLock}
                >
                  <Icon name={locked ? 'lock' : 'unlock'} />
                </TooltipIconButton>
              </div>
              <p
                className={cn('text-xs', invalid ? 'text-destructive' : 'text-muted-foreground')}
                role={invalid ? 'alert' : undefined}
              >
                {sizeHint}
              </p>
            </Section>
            <Section title={t('export.preview')}>
              <div className="max-h-48 divide-y divide-border overflow-y-auto" aria-live="polite">
                {imageSources.map((source, index) => (
                  <div key={source.id} className="flex items-center gap-3 py-3">
                    {source.preview && (
                      <img
                        src={source.preview}
                        alt=""
                        className="size-9 shrink-0 rounded-md object-contain bg-muted"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs" title={source.name}>
                        {source.name}
                      </p>
                      {originals[index] && (
                        <p className="text-label-sm text-muted-foreground tabular-nums">
                          {originals[index].width} × {originals[index].height} px
                        </p>
                      )}
                    </div>
                    <div className="shrink-0 text-right text-xs tabular-nums">
                      {settings.rows.map((row) => {
                        const original = originals[index]
                        const output =
                          original &&
                          exportSize(
                            original.width,
                            original.height,
                            settings.mode,
                            settings.value,
                            row.scale,
                            settings.stretch,
                          )
                        let outputLabel = t('export.unknownSize')
                        if (invalid) outputLabel = t('export.pendingSize')
                        else if (output) outputLabel = `${output.width} × ${output.height}`
                        return (
                          <p key={row.id} className="text-primary">
                            {outputLabel}
                            <span className="ml-2 text-label-sm text-muted-foreground">
                              {row.scale}x {formatLabel(row.format)}
                            </span>
                          </p>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </Section>
            <Section
              title={t('export.outputs')}
              action={
                <TooltipIconButton
                  className="size-7"
                  tooltip={t('export.addRow')}
                  disabled={settings.rows.length >= 8}
                  onClick={() =>
                    setSettings((prev) => ({
                      ...prev,
                      rows: [
                        ...prev.rows,
                        { id: crypto.randomUUID(), scale: 2, format: 'image/png' },
                      ],
                    }))
                  }
                >
                  <Icon name="add" />
                </TooltipIconButton>
              }
            >
              {settings.rows.map((row, index) => {
                const outputs = outputSizes(row.scale)
                const width = sharedAxis('width', outputs)
                const height = sharedAxis('height', outputs)
                const output = width && height ? { width, height } : null
                return (
                  <div key={row.id} className="flex items-center gap-2">
                    <Select
                      value={String(row.scale)}
                      onValueChange={(value) => updateRow(row.id, { scale: Number(value) })}
                      disabled={busy}
                    >
                      <SelectTrigger
                        aria-label={t('export.scaleRow', { index: index + 1 })}
                        className={cn(FIELD, 'w-20 shrink-0')}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent data-shadcn-modal className="z-[1400]">
                        {[0.5, 1, 2, 3, 4].map((scale) => (
                          <SelectItem key={scale} value={String(scale)}>
                            {scale}x
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={row.format}
                      onValueChange={(value) =>
                        updateRow(row.id, { format: value as typeof row.format })
                      }
                      disabled={busy}
                    >
                      <SelectTrigger
                        aria-label={t('export.formatRow', { index: index + 1 })}
                        className={cn(FIELD, 'min-w-0 flex-1')}
                      >
                        <SelectValue />
                        {output && (
                          <small className="ml-auto mr-2 hidden min-w-0 truncate text-xs text-muted-foreground tabular-nums min-[400px]:inline">
                            {output.width} × {output.height}
                          </small>
                        )}
                      </SelectTrigger>
                      <SelectContent data-shadcn-modal className="z-[1400]">
                        {formats.map((format) => (
                          <SelectItem key={format} value={format}>
                            {formatLabel(format)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <TooltipIconButton
                      className={ICON_BUTTON}
                      tooltip={t('export.removeRow')}
                      disabled={settings.rows.length === 1}
                      onClick={() =>
                        setSettings((prev) => ({
                          ...prev,
                          rows: prev.rows.filter((one) => one.id !== row.id),
                        }))
                      }
                    >
                      <Icon name="close" />
                    </TooltipIconButton>
                  </div>
                )
              })}
            </Section>
            {settings.rows.some((row) => row.format !== 'image/png') && (
              <Section
                title={t('params.quality')}
                action={
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {settings.quality}%
                  </span>
                }
              >
                <Slider
                  aria-label={t('params.quality')}
                  min={10}
                  max={100}
                  step={1}
                  value={[settings.quality]}
                  disabled={busy}
                  onValueChange={([quality]) => setSettings((prev) => ({ ...prev, quality }))}
                />
              </Section>
            )}
          </fieldset>
        )}
        <div className="space-y-1.5 text-xs text-muted-foreground empty:hidden">
          {images > 0 && settings.rows.some((row) => row.format === 'image/jpeg') && (
            <p>{t('export.jpegHint')}</p>
          )}
          {sources.some((source) => source.media === 'video') && <p>{t('export.videoHint')}</p>}
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {done > 0 && (
          <p role="status" className="text-sm text-primary">
            {t('export.done', { count: done })}
          </p>
        )}
      </div>
      <footer className="space-y-2 border-t border-border px-5 py-4">
        <Button
          className="h-10 w-full rounded-lg"
          disabled={!sources.length || invalid || loading || busy}
          onClick={() => void run()}
        >
          {busy ? (
            <>
              <Icon name="loading" className="animate-spin" />
              {t('export.progress', { done: progress, total: sources.length })}
            </>
          ) : (
            <>
              <Icon name="download" />
              {t('export.action', { count })}
            </>
          )}
        </Button>
        {count > 1 && (
          <p className="text-center text-xs text-muted-foreground">{t('export.zipHint')}</p>
        )}
      </footer>
    </div>
  )
}

function Section({
  title,
  action,
  children,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="space-y-2.5">
      <div className="flex h-7 items-center justify-between">
        <h3 className="text-sm font-medium">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}
