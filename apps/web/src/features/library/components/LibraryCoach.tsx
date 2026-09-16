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
      className="animate-coach-pop-in absolute right-0 top-full z-50 mt-3 w-72 rounded-2xl border border-blue-100 bg-white p-4 shadow-xl ring-1 ring-black/5 dark:border-blue-500/20 dark:bg-gray-900 dark:ring-white/10"
    >
      <span
        aria-hidden
        className="absolute -top-1.5 right-4 h-3 w-3 rotate-45 border-l border-t border-blue-100 bg-white dark:border-blue-500/20 dark:bg-gray-900"
      />

      <div className="flex items-start gap-2">
        <LibraryIcon className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
        <div className="flex-1">
          <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('coach.title')}
          </div>
          <ol className="mt-2 space-y-1.5 text-xs text-gray-600 dark:text-gray-400">
            {steps.map((step) => (
              <li key={step.token} className="flex items-center gap-1.5">
                <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-700 dark:bg-white/[0.08] dark:text-gray-200">
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
          className="rounded-md px-2.5 py-1 text-xs text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
        >
          {t('coach.gotIt')}
        </button>
        <button
          type="button"
          onClick={() => {
            onDismiss()
            openLibrary()
          }}
          className="inline-flex items-center gap-1 rounded-md bg-blue-500 px-2.5 py-1 text-xs font-medium text-white shadow-sm transition hover:bg-blue-600"
        >
          <LibraryIcon className="h-3 w-3" />
          {t('coach.view')}
        </button>
      </div>
    </div>
  )
}
