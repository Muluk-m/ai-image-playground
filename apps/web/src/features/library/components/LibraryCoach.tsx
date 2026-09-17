import { useEffect, useState } from 'react'
import { LibraryIcon } from '../../../components/icons'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import { useLibraryStore } from '../store'

/** Header 共用这一份状态驱动气泡与按钮高亮，出现即消耗自动展示机会。 */
export function useLibraryCoach() {
  const allowed = useStore(
    (s) =>
      !s.libraryPanelOpened &&
      // 灵感库引导的出现条件，两张卡不同屏。
      !(!s.inspirationCoachDismissed && s.tasks.length === 0),
  )
  const dismissed = useStore((s) => s.libraryCoachDismissed)
  const eligible = allowed && !dismissed
  const [visible, setVisible] = useState(eligible)

  useEffect(() => {
    if (!eligible) return
    // 持久化只管下次不再弹；这一次仍留在屏幕上，直到用户关闭或打开面板。
    useStore.getState().dismissLibraryCoach()
    setVisible(true)
  }, [eligible])

  return { active: visible && allowed, dismiss: () => setVisible(false) }
}

/** 只渲染气泡本身；按钮的脉冲动画与定位锚点由 Header 控制。 */
export default function LibraryCoach({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useTranslation('library')
  const openLibrary = useLibraryStore((s) => s.openPanel)
  const steps = [
    { token: t('coach.tokenRightClick'), text: t('coach.stepSave') },
    { token: '@', text: t('coach.stepMention') },
    { token: t('coach.tokenSlot'), text: t('coach.stepSlot') },
    { token: '/', text: t('coach.stepTemplate') },
  ]

  return (
    <div
      role="dialog"
      aria-label={t('coach.ariaLabel')}
      className="animate-coach-pop-in absolute right-0 top-full z-50 mt-3 w-72 rounded-2xl border border-primary bg-card p-4 shadow-xl ring-1 ring-black/5 dark:ring-white/10"
    >
      <span
        aria-hidden
        className="absolute -top-1.5 right-4 h-3 w-3 rotate-45 border-l border-t border-primary bg-card"
      />

      <div className="flex items-start gap-2">
        <LibraryIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="flex-1">
          <div className="text-sm font-semibold text-foreground">{t('coach.title')}</div>
          <ol className="mt-2 space-y-1.5 text-xs text-muted-foreground">
            {steps.map((step) => (
              <li key={step.token} className="flex items-center gap-1.5">
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                  {step.token}
                </span>
                {step.text}
              </li>
            ))}
          </ol>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          {t('coach.gotIt')}
        </button>
        <button
          type="button"
          onClick={() => {
            onDismiss()
            openLibrary()
          }}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
        >
          <LibraryIcon className="h-3 w-3" />
          {t('coach.view')}
        </button>
      </div>
    </div>
  )
}
