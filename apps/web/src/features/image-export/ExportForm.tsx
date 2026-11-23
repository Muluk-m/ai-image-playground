import { Button } from '../../components/ui/button'
import { Icon } from '../../components/ui/icon'
import { OverflowText } from '../../components/ui/overflowTitle'
import { useTranslation } from '../../i18n'
import { formatLabel } from '../toolbox/lib/encode'
import ExportControls, { ExportSection, ExportStatusMessages } from './ExportControls'
import { type ExportSource, exportSize } from './export'
import { useExportState } from './useExportState'

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
  const state = useExportState({ sources, name, onBusyChange })
  const {
    settings,
    dimensions,
    preview,
    loading,
    progress,
    busy,
    error,
    done,
    single,
    first,
    imageSources,
    images,
    empty,
    count,
    locked,
    originals,
    invalid,
    hasJpeg,
    hasVideo,
    canExport,
    runExport,
  } = state

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overflow-x-hidden px-5 py-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
            {single && preview ? (
              <img src={preview} alt="" className="size-full object-cover" />
            ) : (
              <Icon name="images" size="md" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            {empty ? (
              <p className="text-sm font-medium">{t('export.description')}</p>
            ) : single && first ? (
              <OverflowText as="p" text={first.name} className="truncate text-sm font-medium" />
            ) : (
              <p className="truncate text-sm font-medium">
                {t('export.selected', { count: sources.length })}
              </p>
            )}
            {!empty && (
              <p className="mt-0.5 font-mono text-xs text-muted-foreground tabular-nums">
                {loading
                  ? t('export.loading')
                  : dimensions
                    ? `${dimensions.width} × ${dimensions.height} px`
                    : !single && t(locked ? 'export.batchHint' : 'export.ratioUnlocked')}
              </p>
            )}
          </div>
        </div>

        {(empty || images > 0) && (
          <ExportControls state={state}>
            {imageSources.length > 0 && (
              <ExportSection title={t('export.preview')}>
                {single ? (
                  <div
                    className="divide-y divide-border rounded-xl border border-border bg-card/50 px-3"
                    aria-live="polite"
                  >
                    {settings.rows.map((row) => {
                      const original = originals[0]
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
                      else if (output) outputLabel = `${output.width} × ${output.height} px`
                      return (
                        <div
                          key={row.id}
                          className="flex min-w-0 items-center justify-between gap-3 py-2 text-xs tabular-nums"
                        >
                          <span className="font-mono text-muted-foreground">
                            {row.scale}x {formatLabel(row.format)}
                          </span>
                          <span className="truncate font-mono font-medium text-primary">
                            {outputLabel}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div
                    className="max-h-48 divide-y divide-border overflow-y-auto rounded-xl border border-border bg-card/50"
                    aria-live="polite"
                  >
                    {imageSources.map((source, index) => {
                      const original = originals[index]
                      return (
                        <div key={source.id} className="min-w-0 space-y-1.5 px-3 py-2.5">
                          <div className="flex min-w-0 items-center gap-2">
                            {source.preview && (
                              <img
                                src={source.preview}
                                alt=""
                                className="size-7 shrink-0 rounded-md bg-muted object-contain"
                              />
                            )}
                            <OverflowText
                              as="p"
                              text={source.name}
                              className="min-w-0 flex-1 truncate text-xs font-medium"
                            />
                            {original && (
                              <span className="shrink-0 font-mono text-label-sm text-muted-foreground tabular-nums">
                                {original.width} × {original.height}
                              </span>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {settings.rows.map((row) => {
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
                                <span
                                  key={row.id}
                                  className="inline-flex items-center gap-1.5 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-label-sm tabular-nums"
                                >
                                  <span className="text-primary">{outputLabel}</span>
                                  <span className="text-muted-foreground">
                                    {row.scale}x {formatLabel(row.format)}
                                  </span>
                                </span>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </ExportSection>
            )}
          </ExportControls>
        )}

        <ExportStatusMessages hasJpeg={hasJpeg} hasVideo={hasVideo} error={error} done={done} />
      </div>

      <footer className="space-y-2 border-t border-border px-5 py-4">
        {empty ? (
          <p className="py-2 text-center text-sm text-muted-foreground">
            {t('export.addToExport')}
          </p>
        ) : (
          <Button
            size="lg"
            className="w-full"
            disabled={!canExport}
            onClick={() => void runExport()}
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
        )}
        {count > 1 && (
          <p className="text-center text-xs text-muted-foreground">{t('export.zipHint')}</p>
        )}
      </footer>
    </div>
  )
}
