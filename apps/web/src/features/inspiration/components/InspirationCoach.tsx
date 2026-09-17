import { SparkleIcon } from '../../../components/icons'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import { useInspirationStore } from '../store'

/**
 * 新人引导气泡：第一次访问、尚未生成过任何图、且未主动 dismiss 时，在 Header
 * 灵感库按钮下方浮一个引导卡片。一旦用户点过「看看」「知道了」、或者主动
 * 打开过灵感库、或者跑出第一张图，永久 dismiss。
 *
 * 仅渲染气泡本身；按钮的脉冲动画与定位锚点由 Header 控制。
 */
export default function InspirationCoach() {
  const tasksCount = useStore((s) => s.tasks.length)
  const dismissed = useStore((s) => s.inspirationCoachDismissed)
  const dismiss = useStore((s) => s.dismissInspirationCoach)
  const openInspiration = useInspirationStore((s) => s.openPanel)
  const panelOpen = useInspirationStore((s) => s.panelOpen)
  const { t } = useTranslation('inspiration')

  if (dismissed) return null
  if (tasksCount > 0) return null
  if (panelOpen) return null

  const handleExplore = () => {
    dismiss()
    openInspiration()
  }

  return (
    <div
      role="dialog"
      aria-label={t('coach.label')}
      className="animate-coach-pop-in absolute right-0 top-full z-50 mt-3 w-72 rounded-2xl border border-primary bg-card p-4 shadow-xl ring-1 ring-black/5 dark:ring-white/10"
    >
      {/* 气泡尖角，指向上方的按钮 */}
      <span
        aria-hidden
        className="absolute -top-1.5 right-4 h-3 w-3 rotate-45 border-l border-t border-primary bg-card"
      />

      <div className="flex items-start gap-2">
        <SparkleIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="flex-1">
          <div className="text-sm font-semibold text-foreground">{t('coach.title')}</div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('coach.body')}</p>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={dismiss}
          className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          {t('coach.dismiss')}
        </button>
        <button
          type="button"
          onClick={handleExplore}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
        >
          <SparkleIcon className="h-3 w-3" />
          {t('coach.explore')}
        </button>
      </div>
    </div>
  )
}
