import { useUpdateAvailable } from '../hooks/useUpdateAvailable'
import { useTranslation } from '../i18n'
import { Button } from './ui/button'

/** 提示条不进 Overlay：它不是模态浮层，不锁滚动、不吃 ESC、不挡工作区。z 压在 Toast 之下。 */
export default function UpdateBanner() {
  const { t } = useTranslation('shell')
  const { availableVersion, skip } = useUpdateAvailable()

  if (!availableVersion) return null

  return (
    <div
      role="status"
      className="animate-slide-down-in fixed right-3 sm:right-4 z-[1390] max-w-[calc(100vw-1.5rem)]"
      style={{ top: 'calc(var(--safe-area-top) + var(--header-height) + 0.75rem)' }}
    >
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border/60 bg-card/95 backdrop-blur-xl px-4 py-2.5 shadow-popover ring-1 ring-hairline">
        <span className="text-sm font-medium text-foreground">{t('update.available')}</span>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" type="button" onClick={() => window.location.reload()}>
            {t('update.refresh')}
          </Button>
          <Button size="sm" type="button" onClick={skip} variant="outline">
            {t('update.skip')}
          </Button>
        </div>
      </div>
    </div>
  )
}
