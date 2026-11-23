import type { ReactNode } from 'react'
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
import { formatLabel } from '../toolbox/lib/encode'
import {
  EXPORT_FORMATS,
  EXPORT_SCALES,
  type ExportError,
  type ExportState,
  SCALE_PRESETS,
  validSize,
} from './useExportState'

const NUMBER_INPUT =
  'bg-background font-mono tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'

export function ExportSection({
  title,
  action,
  children,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="min-w-0 space-y-2.5">
      <div className="flex h-7 min-w-0 items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

export function ExportStatusMessages({
  hasJpeg,
  hasVideo,
  error,
  done,
}: {
  hasJpeg: boolean
  hasVideo: boolean
  error: ExportError | null
  done: number
}) {
  const { t } = useTranslation('toolbox')
  const errorText =
    error?.key === 'export.limit'
      ? t('export.limit', { width: error.width, height: error.height })
      : error
        ? t(error.key)
        : ''
  return (
    <>
      {(hasJpeg || hasVideo) && (
        <div className="space-y-1.5 text-xs text-muted-foreground">
          {hasJpeg && <p>{t('export.jpegHint')}</p>}
          {hasVideo && <p>{t('export.videoHint')}</p>}
        </div>
      )}
      {errorText && (
        <p role="alert" className="text-xs text-destructive">
          {errorText}
        </p>
      )}
      {done > 0 && (
        <p role="status" className="text-xs text-primary">
          {t('export.done', { count: done })}
        </p>
      )}
    </>
  )
}

/** 尺寸、快捷缩放、导出规格与质量控件：工具箱参数栏与导出抽屉共用。 */
export default function ExportControls({
  state,
  children,
}: {
  state: ExportState
  /** 可选附加区块（如抽屉模式下的输出预览列表）。 */
  children?: ReactNode
}) {
  const { t } = useTranslation('toolbox')
  const {
    settings,
    dimensions,
    busy,
    empty,
    single,
    locked,
    invalid,
    isSizeModified,
    activePercent,
    hasLossy,
    sizeDraft,
    fieldValue,
    changeSize,
    applyPercent,
    toggleLock,
    resetSize,
    updateRow,
    addRow,
    removeRow,
    setQuality,
  } = state

  return (
    <fieldset
      disabled={busy || empty}
      className={cn('min-w-0 w-full space-y-5', empty && 'opacity-60')}
    >
      <ExportSection
        title={t('export.size')}
        action={
          isSizeModified ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="text-muted-foreground hover:text-foreground"
              onClick={resetSize}
            >
              {t('export.reset')}
            </Button>
          ) : undefined
        }
      >
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-1.5">
          <div className="min-w-0 space-y-1.5">
            <Label
              htmlFor="export-width"
              className="flex items-center justify-between text-label-sm text-muted-foreground"
            >
              <span>{t('export.width')}</span>
              <span className="font-mono font-normal">px</span>
            </Label>
            <Input
              id="export-width"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              className={NUMBER_INPUT}
              aria-label={t('export.width')}
              placeholder={t('export.multipleValues')}
              value={fieldValue('width')}
              disabled={single && !dimensions}
              onChange={(event) => changeSize('width', event.target.value)}
              aria-invalid={sizeDraft.width !== undefined && !validSize(sizeDraft.width)}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t(locked ? 'export.ratioUnlock' : 'export.ratioLock')}
            aria-pressed={locked}
            disabled={invalid || (single && !dimensions)}
            onClick={toggleLock}
            className={cn(
              'shrink-0',
              locked
                ? 'border-primary/40 bg-primary/15 text-primary hover:bg-primary/20 hover:text-primary'
                : 'bg-background text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon name={locked ? 'lock' : 'unlock'} />
          </Button>
          <div className="min-w-0 space-y-1.5">
            <Label
              htmlFor="export-height"
              className="flex items-center justify-between text-label-sm text-muted-foreground"
            >
              <span>{t('export.height')}</span>
              <span className="font-mono font-normal">px</span>
            </Label>
            <Input
              id="export-height"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              className={NUMBER_INPUT}
              aria-label={t('export.height')}
              placeholder={t('export.multipleValues')}
              value={fieldValue('height')}
              disabled={single && !dimensions}
              onChange={(event) => changeSize('height', event.target.value)}
              aria-invalid={sizeDraft.height !== undefined && !validSize(sizeDraft.height)}
            />
          </div>
        </div>

        <div
          role="radiogroup"
          aria-label={t('export.scalePresets')}
          className="grid min-w-0 grid-cols-5 gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5"
        >
          {SCALE_PRESETS.map((percent) => {
            const active = activePercent === percent
            return (
              <Button
                key={percent}
                type="button"
                variant="ghost"
                size="xs"
                role="radio"
                aria-checked={active}
                disabled={single && !dimensions}
                onClick={() => applyPercent(percent)}
                className={cn(
                  'min-w-0 px-0 font-mono text-label-sm tabular-nums',
                  active
                    ? 'bg-primary/15 font-medium text-primary hover:bg-primary/15 hover:text-primary'
                    : 'font-normal text-muted-foreground hover:text-foreground',
                )}
              >
                {percent}%
              </Button>
            )
          })}
        </div>

        {invalid ? (
          <p className="text-xs text-destructive" role="alert">
            {t('export.invalidSize')}
          </p>
        ) : !locked ? (
          <p className="text-label-sm text-muted-foreground">{t('export.ratioUnlocked')}</p>
        ) : null}
      </ExportSection>

      <ExportSection
        title={t('export.outputs')}
        action={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={settings.rows.length >= 8}
            onClick={addRow}
            className="text-muted-foreground hover:text-foreground"
          >
            <Icon name="add" />
            {t('export.addRow')}
          </Button>
        }
      >
        <div className="space-y-2">
          {settings.rows.map((row, index) => (
            <div key={row.id} className="flex min-w-0 items-center gap-1.5">
              <Select
                value={String(row.scale)}
                onValueChange={(value) => updateRow(row.id, { scale: Number(value) })}
                disabled={busy || empty}
              >
                <SelectTrigger
                  aria-label={t('export.scaleRow', { index: index + 1 })}
                  className="w-20 shrink-0 bg-background font-mono text-xs tabular-nums"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent data-shadcn-modal className="z-[1400]">
                  {EXPORT_SCALES.map((scale) => (
                    <SelectItem key={scale} value={String(scale)}>
                      {scale}x
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={row.format}
                onValueChange={(value) => updateRow(row.id, { format: value as typeof row.format })}
                disabled={busy || empty}
              >
                <SelectTrigger
                  aria-label={t('export.formatRow', { index: index + 1 })}
                  className="min-w-0 flex-1 bg-background text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent data-shadcn-modal className="z-[1400]">
                  {EXPORT_FORMATS.map((format) => (
                    <SelectItem key={format} value={format}>
                      {formatLabel(format)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {settings.rows.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('export.removeRow')}
                  onClick={() => removeRow(row.id)}
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                >
                  <Icon name="close" />
                </Button>
              )}
            </div>
          ))}
        </div>
      </ExportSection>

      {hasLossy && (
        <ExportSection
          title={t('params.quality')}
          action={
            <span className="font-mono text-xs tabular-nums text-foreground">
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
            disabled={busy || empty}
            onValueChange={([quality]) => setQuality(quality)}
          />
        </ExportSection>
      )}

      {children}
    </fieldset>
  )
}
