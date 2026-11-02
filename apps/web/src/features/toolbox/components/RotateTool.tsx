import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Checkbox } from '../../../components/patterns/Checkbox'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Input } from '../../../components/ui/input'
import { OverflowText } from '../../../components/ui/overflowTitle'
import { Slider } from '../../../components/ui/slider'
import { useTranslation } from '../../../i18n'
import { outputFileName } from '../lib/naming'
import {
  DEFAULT_ROTATION,
  normalizeAngle,
  type RotationSettings,
  renderRotation,
  rotateImage,
  rotationSize,
} from '../lib/rotation'
import type { ToolSource } from '../lib/tool'
import { useToolResults } from '../lib/useToolResults'
import { toolSource, useToolboxStore } from '../store'
import { rotateTool } from '../tools/rotate'
import { Field } from './fields'
import { FailureText } from './ToolResultCard'
import ToolShell from './ToolShell'

function AngleInput({ value, onChange }: { value: number; onChange: (angle: number) => void }) {
  const { t } = useTranslation('toolbox')
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  return (
    <Input
      type="number"
      aria-label={t('rotation.angle')}
      min={-180}
      max={180}
      step={0.1}
      value={draft}
      className="w-24 text-right tabular-nums"
      onChange={(event) => {
        const next = event.target.value
        setDraft(next)
        if (next.trim() && Number.isFinite(Number(next)))
          onChange(Math.max(-180, Math.min(180, Number(next))))
      }}
      onBlur={() => setDraft(String(value))}
    />
  )
}

function RotationPreview({ source, settings }: { source: ToolSource; settings: RotationSettings }) {
  const { t } = useTranslation('toolbox')
  const ref = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const target = ref.current
    if (!target) return
    try {
      // Preview at screen resolution; exports always render from the original bitmap.
      const rendered = renderRotation(source.bitmap, settings, 1200)
      target.width = rendered.width
      target.height = rendered.height
      const ctx = target.getContext('2d')
      if (!ctx) throw new Error('2d context unavailable')
      ctx.drawImage(rendered, 0, 0)
      rendered.width = rendered.height = 0
      setFailed(false)
    } catch {
      target.width = target.height = 0
      setFailed(true)
    }
  }, [source, settings])
  return (
    <>
      <canvas
        ref={ref}
        role="img"
        aria-label={t('rotation.adjusted')}
        className="h-full w-full object-contain"
      />
      {failed && <div className="absolute text-sm text-destructive">{t('result.failed')}</div>}
    </>
  )
}

export default function RotateTool() {
  const { t } = useTranslation('toolbox')
  const items = useToolboxStore((state) => state.items)
  const remove = useToolboxStore((state) => state.remove)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [settingsById, setSettingsById] = useState<Record<string, RotationSettings>>({})
  const [grid, setGrid] = useState(true)
  const selected = items.find((item) => item.id === selectedId) ?? items[0]
  const settings = (selected && settingsById[selected.id]) ?? DEFAULT_ROTATION
  const source = useMemo(() => (selected ? toolSource(selected) : null), [selected])
  const selectedItems = useMemo(() => (selected ? [selected] : []), [selected])
  const run = useCallback((input: ToolSource) => rotateImage(input, settings), [settings])
  const { results, busy } = useToolResults(selectedItems, run)
  const result = selected ? results.get(selected.id) : undefined
  const done = result?.status === 'done' ? result : null
  const size = selected ? rotationSize(selected.width, selected.height, settings) : null
  const patch = (next: Partial<RotationSettings>) => {
    if (selected)
      setSettingsById((previous) => ({
        ...previous,
        [selected.id]: { ...settings, ...next },
      }))
  }
  const turn = (degrees: number) => patch({ angle: normalizeAngle(settings.angle + degrees) })
  return (
    <ToolShell
      tool={rotateTool}
      processing={busy}
      downloadLabel={t('rotation.export')}
      deliverables={
        done && selected
          ? [
              {
                name: outputFileName(selected.name, done.output.type),
                blob: done.output.blob,
              },
            ]
          : []
      }
      summary={
        <div className="space-y-1 text-xs text-muted-foreground" aria-live="polite">
          <div className="flex items-center justify-between gap-2">
            <span>{t('rotation.lossless')}</span>
            {size && (
              <span>
                {size.width} × {size.height}
              </span>
            )}
          </div>
          {busy && <div>{t('result.processing')}</div>}
          {result?.status === 'failed' && <FailureText failure={result.failure} />}
        </div>
      }
      controls={
        <div className="space-y-6">
          <Field label={t('params.rotate')}>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1 px-2" onClick={() => turn(-90)}>
                <Icon name="rotate" className="-scale-x-100" />
                {t('rotation.left')}
              </Button>
              <Button variant="outline" className="flex-1 px-2" onClick={() => turn(90)}>
                <Icon name="rotate" />
                {t('rotation.right')}
              </Button>
            </div>
          </Field>
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm">{t('rotation.angle')}</span>
              <div className="flex items-center gap-1">
                <AngleInput value={settings.angle} onChange={(angle) => patch({ angle })} />
                <span className="text-sm text-muted-foreground">°</span>
              </div>
            </div>
            <Slider
              aria-label={t('rotation.angle')}
              value={[settings.angle]}
              min={-180}
              max={180}
              step={0.1}
              onValueChange={([angle]) => patch({ angle })}
            />
            <div className="flex justify-between text-label-sm text-muted-foreground tabular-nums">
              <span>−180°</span>
              <span>0°</span>
              <span>180°</span>
            </div>
            <div className="flex justify-center gap-2">
              <Button variant="outline" size="sm" onClick={() => turn(-0.1)}>
                −0.1°
              </Button>
              <Button variant="outline" size="sm" onClick={() => turn(0.1)}>
                +0.1°
              </Button>
            </div>
          </div>
          <Field label={t('rotation.mirror')}>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1 aria-pressed:border-primary aria-pressed:bg-accent aria-pressed:text-primary"
                aria-pressed={settings.flipH}
                onClick={() => patch({ flipH: !settings.flipH })}
              >
                <Icon name="flipHorizontal" />
                {t('params.flipH')}
              </Button>
              <Button
                variant="outline"
                className="flex-1 aria-pressed:border-primary aria-pressed:bg-accent aria-pressed:text-primary"
                aria-pressed={settings.flipV}
                onClick={() => patch({ flipV: !settings.flipV })}
              >
                <Icon name="flipVertical" />
                {t('params.flipV')}
              </Button>
            </div>
          </Field>
          <div className="space-y-4 border-t border-border pt-5">
            <Checkbox label={t('rotation.grid')} checked={grid} onChange={setGrid} />
            <Checkbox
              label={t('rotation.expand')}
              checked={settings.expand}
              onChange={(expand) => patch({ expand })}
            />
          </div>
          <Button variant="ghost" className="w-full" onClick={() => patch(DEFAULT_ROTATION)}>
            <Icon name="undo" />
            {t('rotation.reset')}
          </Button>
        </div>
      }
    >
      {() => (
        <section className="flex min-w-0 flex-none flex-col gap-4 lg:min-h-0 lg:flex-1">
          <div className="flex items-center justify-between gap-3">
            <OverflowText
              text={selected?.name ?? ''}
              className="min-w-0 truncate text-sm font-medium"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('result.remove')}
              onClick={() => selected && remove(selected.id)}
            >
              <Icon name="close" />
            </Button>
          </div>
          <div className="grid min-h-80 flex-1">
            <figure className="flex min-h-64 min-w-0 flex-col gap-3">
              <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-[repeating-conic-gradient(hsl(var(--muted)/0.35)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] p-4">
                {source ? (
                  <RotationPreview source={source} settings={settings} />
                ) : (
                  <div className="grid h-full place-items-center text-sm text-destructive">
                    {t('result.undecodable')}
                  </div>
                )}
                {grid && (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-4 grid grid-cols-3 grid-rows-3"
                  >
                    {Array.from({ length: 9 }, (_, index) => (
                      <div key={index} className="border border-primary/20" />
                    ))}
                  </div>
                )}
              </div>
              <figcaption className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{t('rotation.adjusted')}</span>
                {size && (
                  <span className="tabular-nums">
                    {size.width} × {size.height}
                  </span>
                )}
              </figcaption>
            </figure>
          </div>
          <div
            className="flex shrink-0 gap-2 overflow-x-auto py-1"
            aria-label={t('rotation.images')}
          >
            {items.map((item) => (
              <Button
                key={item.id}
                variant="ghost"
                aria-label={item.name}
                aria-pressed={selected?.id === item.id}
                onClick={() => setSelectedId(item.id)}
                className="h-16 w-12 shrink-0 overflow-hidden rounded border border-border p-0 aria-pressed:border-primary aria-pressed:ring-1 aria-pressed:ring-primary"
              >
                <img src={item.url} alt="" className="h-full w-full object-cover" />
              </Button>
            ))}
          </div>
        </section>
      )}
    </ToolShell>
  )
}
