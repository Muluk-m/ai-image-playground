import { Download, Images, LoaderCircle, Minus, Plus, RotateCcw } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
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
import {
  type ExportSettings,
  type ExportSource,
  exportSize,
  prepareExports,
  type SizeMode,
} from './export'

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
  const modeLabels = {
    original: t('export.by.original'),
    width: t('export.by.width'),
    height: t('export.by.height'),
    percent: t('export.by.percent'),
  }
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
  const [sizeDraft, setSizeDraft] = useState<{ field: SizeMode; text: string } | null>(null)
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
    setSizeDraft(null)
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
  const outputSize = (scale: number) =>
    dimensions
      ? exportSize(
          dimensions.width,
          dimensions.height,
          settings.mode,
          settings.value > 0 ? settings.value : 1,
          scale,
        )
      : null
  const size = outputSize(1)
  const changeMode = (mode: SizeMode) => {
    setSizeDraft(null)
    setSettings((prev) => ({
      ...prev,
      mode,
      value: mode === 'percent' || mode === 'original' ? 100 : (dimensions?.[mode] ?? 1440),
    }))
  }
  const validSize = (mode: SizeMode, text: string) => {
    const value = Number(text)
    return (
      text.trim() !== '' &&
      Number.isFinite(value) &&
      value > 0 &&
      (mode === 'percent' || Number.isInteger(value))
    )
  }
  const changeSize = (field: SizeMode, text: string) => {
    setSizeDraft({ field, text })
    if (validSize(field, text))
      setSettings((prev) => ({ ...prev, mode: field, value: Number(text) }))
  }
  const invalid =
    (sizeDraft !== null && !validSize(sizeDraft.field, sizeDraft.text)) ||
    !Number.isFinite(settings.value) ||
    settings.value <= 0 ||
    ((settings.mode === 'width' || settings.mode === 'height') && !Number.isInteger(settings.value))
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
              <Images className="size-5" aria-hidden="true" />
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
                  : !single && t('export.batchHint')}
            </p>
          </div>
        </div>
        {images > 0 && (
          <fieldset disabled={busy} className="space-y-6">
            <Section title={t('export.size')}>
              {single ? (
                <div className="flex gap-2">
                  {(['width', 'height'] as const).map((axis) => (
                    <Affix key={axis} before={axis === 'width' ? 'W' : 'H'}>
                      <Input
                        id={`export-${axis}`}
                        type="number"
                        min={1}
                        step={1}
                        className={cn(FIELD, 'pl-8 tabular-nums')}
                        aria-label={axisLabels[axis]}
                        value={sizeDraft?.field === axis ? sizeDraft.text : (size?.[axis] ?? '')}
                        disabled={!size}
                        onChange={(event) => changeSize(axis, event.target.value)}
                        aria-invalid={sizeDraft?.field === axis && invalid}
                      />
                    </Affix>
                  ))}
                  <Button
                    variant="ghost"
                    size="icon"
                    className={ICON_BUTTON}
                    aria-label={t('export.reset')}
                    title={t('export.reset')}
                    disabled={settings.mode === 'original' && !sizeDraft}
                    onClick={() => changeMode('original')}
                  >
                    <RotateCcw />
                  </Button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Select
                    value={settings.mode}
                    onValueChange={(value) => changeMode(value as SizeMode)}
                    disabled={busy}
                  >
                    <SelectTrigger
                      aria-label={t('export.size')}
                      className={cn(FIELD, 'min-w-0 flex-1')}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent data-shadcn-modal className="z-[1400]">
                      {(['original', 'width', 'height', 'percent'] as const).map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {modeLabels[mode]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {settings.mode !== 'original' && (
                    <Affix after={settings.mode === 'percent' ? '%' : 'px'}>
                      <Input
                        id="export-size-value"
                        type="number"
                        min={1}
                        className={cn(FIELD, 'pr-9 tabular-nums')}
                        aria-label={modeLabels[settings.mode]}
                        value={sizeDraft?.field === settings.mode ? sizeDraft.text : settings.value}
                        onChange={(event) => changeSize(settings.mode, event.target.value)}
                        aria-invalid={invalid}
                      />
                    </Affix>
                  )}
                </div>
              )}
            </Section>
            <Section
              title={t('export.outputs')}
              action={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground hover:text-foreground"
                  aria-label={t('export.addRow')}
                  title={t('export.addRow')}
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
                  <Plus />
                </Button>
              }
            >
              {settings.rows.map((row, index) => {
                const output = outputSize(row.scale)
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
                    <Button
                      variant="ghost"
                      size="icon"
                      className={ICON_BUTTON}
                      aria-label={t('export.removeRow')}
                      title={t('export.removeRow')}
                      disabled={settings.rows.length === 1}
                      onClick={() =>
                        setSettings((prev) => ({
                          ...prev,
                          rows: prev.rows.filter((one) => one.id !== row.id),
                        }))
                      }
                    >
                      <Minus />
                    </Button>
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
              <LoaderCircle className="animate-spin" />
              {t('export.progress', { done: progress, total: sources.length })}
            </>
          ) : (
            <>
              <Download />
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

function Affix({
  before,
  after,
  children,
}: {
  before?: string
  after?: string
  children: ReactNode
}) {
  return (
    <div className="relative min-w-0 flex-1">
      {before && (
        <span className="pointer-events-none absolute inset-y-0 left-3 grid place-items-center text-xs text-muted-foreground">
          {before}
        </span>
      )}
      {children}
      {after && (
        <span className="pointer-events-none absolute inset-y-0 right-3 grid place-items-center text-xs text-muted-foreground">
          {after}
        </span>
      )}
    </div>
  )
}
