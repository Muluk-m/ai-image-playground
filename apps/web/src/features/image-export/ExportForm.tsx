import { Download, Link2, LoaderCircle, Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui/button'
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
  const sizeLabels = {
    original: t('export.original'),
    width: t('export.width'),
    height: t('export.height'),
    percent: t('export.percent'),
  }
  const [settings, setSettings] = useState<ExportSettings>({
    mode: 'original',
    value: 100,
    quality: 92,
    rows: [{ id: crypto.randomUUID(), scale: 1, format: 'image/png' }],
  })
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [done, setDone] = useState(0)
  const [sizeDraft, setSizeDraft] = useState<{ field: SizeMode; text: string } | null>(null)
  const abort = useRef<AbortController | null>(null)
  const single = sources.length === 1 && sources[0]?.media === 'image'
  const first = sources[0]
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    let alive = true
    const controller = new AbortController()
    setDimensions(null)
    setError('')
    setDone(0)
    setSizeDraft(null)
    setLoading(false)
    if (!single || !first) return
    setLoading(true)
    void first
      .load(controller.signal)
      .then(createImageBitmap)
      .then((bitmap) => {
        if (alive) setDimensions({ width: bitmap.width, height: bitmap.height })
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
    }
  }, [single, first, t])
  useEffect(() => () => abort.current?.abort(), [])
  useEffect(() => {
    onBusyChange?.(progress !== null)
  }, [progress, onBusyChange])
  const images = sources.filter((one) => one.media === 'image').length
  const count = images * settings.rows.length + sources.length - images
  const size = dimensions
    ? exportSize(
        dimensions.width,
        dimensions.height,
        settings.mode,
        settings.value > 0 ? settings.value : 1,
        1,
      )
    : null
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
  const run = async () => {
    const controller = new AbortController()
    abort.current = controller
    setError('')
    setDone(0)
    setProgress(0)
    try {
      const files = await prepareExports(sources, settings, controller.signal, setProgress)
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
      <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-6 py-6">
        <div className="rounded-xl border border-border bg-muted/30 p-4">
          <p className="text-sm font-medium">
            {single ? first?.name : t('export.selected', { count: sources.length })}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {loading
              ? t('export.loading')
              : dimensions
                ? `${dimensions.width} × ${dimensions.height} px`
                : t('export.batchHint')}
          </p>
        </div>
        {images > 0 && (
          <fieldset disabled={progress !== null} className="space-y-6">
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">{t('export.size')}</h3>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Link2 className="h-3.5 w-3.5" />
                  {t('export.locked')}
                </span>
              </div>
              <Select
                value={settings.mode}
                onValueChange={(value) => changeMode(value as SizeMode)}
                disabled={progress !== null}
              >
                <SelectTrigger aria-label={t('export.size')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent data-shadcn-modal className="z-[1400]">
                  {(['original', 'width', 'height', 'percent'] as const).map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {sizeLabels[mode]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {single && size ? (
                <div className="grid grid-cols-2 gap-3">
                  {(['width', 'height'] as const).map((axis) => (
                    <div key={axis} className="space-y-2">
                      <Label htmlFor={`export-${axis}`}>{sizeLabels[axis]} · px</Label>
                      <Input
                        id={`export-${axis}`}
                        type="number"
                        min={1}
                        step={1}
                        value={sizeDraft?.field === axis ? sizeDraft.text : size[axis]}
                        onChange={(event) => changeSize(axis, event.target.value)}
                        aria-invalid={sizeDraft?.field === axis && invalid}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                settings.mode !== 'original' && (
                  <div className="space-y-2">
                    <Label htmlFor="export-size-value">
                      {sizeLabels[settings.mode]} {settings.mode === 'percent' ? '%' : '· px'}
                    </Label>
                    <Input
                      id="export-size-value"
                      type="number"
                      min={1}
                      value={sizeDraft?.field === settings.mode ? sizeDraft.text : settings.value}
                      onChange={(event) => changeSize(settings.mode, event.target.value)}
                      aria-invalid={invalid}
                    />
                  </div>
                )
              )}
              {single && settings.mode === 'percent' && (
                <div className="space-y-2">
                  <Label htmlFor="export-percent">{t('export.percent')} · %</Label>
                  <Input
                    id="export-percent"
                    type="number"
                    min={1}
                    value={sizeDraft?.field === 'percent' ? sizeDraft.text : settings.value}
                    onChange={(event) => changeSize('percent', event.target.value)}
                    aria-invalid={sizeDraft?.field === 'percent' && invalid}
                  />
                </div>
              )}
            </section>
            <section className="space-y-3">
              <h3 className="text-sm font-medium">{t('export.outputs')}</h3>
              {settings.rows.map((row, index) => (
                <div key={row.id} className="rounded-xl border border-border p-3 space-y-2">
                  <div className="flex gap-2">
                    <Select
                      value={String(row.scale)}
                      onValueChange={(value) =>
                        setSettings((prev) => ({
                          ...prev,
                          rows: prev.rows.map((one) =>
                            one.id === row.id ? { ...one, scale: Number(value) } : one,
                          ),
                        }))
                      }
                      disabled={progress !== null}
                    >
                      <SelectTrigger
                        aria-label={t('export.scaleRow', { index: index + 1 })}
                        className="w-24"
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
                        setSettings((prev) => ({
                          ...prev,
                          rows: prev.rows.map((one) =>
                            one.id === row.id
                              ? { ...one, format: value as typeof row.format }
                              : one,
                          ),
                        }))
                      }
                      disabled={progress !== null}
                    >
                      <SelectTrigger
                        aria-label={t('export.formatRow', { index: index + 1 })}
                        className="flex-1"
                      >
                        <SelectValue />
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
                      aria-label={t('export.removeRow')}
                      disabled={settings.rows.length === 1}
                      onClick={() =>
                        setSettings((prev) => ({
                          ...prev,
                          rows: prev.rows.filter((one) => one.id !== row.id),
                        }))
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  {dimensions && (
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {(() => {
                        const output = exportSize(
                          dimensions.width,
                          dimensions.height,
                          settings.mode,
                          settings.value > 0 ? settings.value : 1,
                          row.scale,
                        )
                        return `${output.width} × ${output.height} px`
                      })()}
                    </p>
                  )}
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                className="w-full border-dashed"
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
                {t('export.addRow')}
              </Button>
            </section>
            {settings.rows.some((row) => row.format !== 'image/png') && (
              <section className="space-y-3">
                <Label>
                  {t('params.quality')}{' '}
                  <span className="float-right tabular-nums">{settings.quality}%</span>
                </Label>
                <Slider
                  aria-label={t('params.quality')}
                  min={10}
                  max={100}
                  step={1}
                  value={[settings.quality]}
                  disabled={progress !== null}
                  onValueChange={([quality]) => setSettings((prev) => ({ ...prev, quality }))}
                />
              </section>
            )}
            {settings.rows.some((row) => row.format === 'image/jpeg') && (
              <p className="text-xs text-muted-foreground">{t('export.jpegHint')}</p>
            )}
          </fieldset>
        )}
        {sources.some((source) => source.media === 'video') && (
          <p className="text-xs text-muted-foreground">{t('export.videoHint')}</p>
        )}
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
      <footer className="space-y-2 border-t border-border px-6 py-4">
        <p className="text-xs text-muted-foreground">
          {t(count > 1 ? 'export.zipHint' : 'export.localHint')}
        </p>
        <Button
          className="w-full h-11 rounded-xl"
          disabled={!sources.length || invalid || loading || progress !== null}
          onClick={() => void run()}
        >
          {progress !== null ? (
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
      </footer>
    </div>
  )
}
