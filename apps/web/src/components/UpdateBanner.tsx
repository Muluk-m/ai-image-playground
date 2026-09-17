import { useUpdateAvailable } from '../hooks/useUpdateAvailable'
import { useTranslation } from '../i18n'

/** 提示条不进 Overlay：它不是模态浮层，不锁滚动、不吃 ESC、不挡工作区。z 压在 Toast 之下。 */
export default function UpdateBanner() {
  const { t } = useTranslation('shell')
  const { availableVersion, skip } = useUpdateAvailable()

  if (!availableVersion) return null

  return (
    <div
      role="status"
      className="animate-slide-down-in fixed right-3 sm:right-4 z-[115] max-w-[calc(100vw-1.5rem)]"
      style={{ top: 'calc(var(--safe-area-top) + var(--header-height) + 0.75rem)' }}
    >
      <div className="flex items-center gap-3 rounded-2xl border border-border/60 bg-card/95 backdrop-blur-xl px-4 py-2.5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.3)] ring-1 ring-black/5 dark:ring-white/10">
        <span className="text-sm font-medium text-foreground">{t('update.available')}</span>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground transition hover:bg-primary/90"
          >
            {t('update.refresh')}
          </button>
          <button
            type="button"
            onClick={skip}
            className="rounded-lg border border-border px-3 py-1.5 text-[13px] text-muted-foreground transition hover:bg-card"
          >
            {t('update.skip')}
          </button>
        </div>
      </div>
    </div>
  )
}
