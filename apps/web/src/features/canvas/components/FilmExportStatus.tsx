import { X } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { useFilmExport } from '../filmExportStore'

/** 导出进行中的浮条：选区换了、工具条收起了，进度和取消仍然在。 */
export default function FilmExportStatus() {
  const { t } = useTranslation('canvas')
  const run = useFilmExport((state) => state.run)
  if (!run) return null
  const percent = Math.round(run.fraction * 100)
  const label =
    run.kind === 'zip'
      ? t('film.zipping')
      : run.phase === 'fetching'
        ? t('film.fetching', { percent })
        : t('film.encoding', { percent })
  return (
    <div
      role="status"
      className="absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-md"
    >
      <div className="flex flex-col gap-1">
        <span>{label}</span>
        {run.kind === 'film' && (
          <div className="h-1 w-48 overflow-hidden rounded bg-muted">
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${percent}%` }}
            />
          </div>
        )}
        <span className="text-muted-foreground">{t('film.keepForeground')}</span>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2"
        onClick={() => useFilmExport.getState().cancel()}
      >
        <X />
        {t('film.cancel')}
      </Button>
    </div>
  )
}
