import { Database, KeyRound, type LucideIcon, SlidersHorizontal } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from '../../i18n'
import { isByokGenerationEnabled } from '../../lib/clientCapabilities'
import { useStore } from '../../store'
import { CloseIcon, SettingsIcon } from '../icons'
import Overlay from '../Overlay'
import ApiTab from './ApiTab'
import DataTab from './DataTab'
import GeneralTab from './GeneralTab'

type SettingsTab = 'general' | 'data' | 'api'

/**
 * 设置弹窗的外壳：标题栏、左侧导航、当前页内容。每一页自己管自己的状态。
 *
 * BYOK 关掉的部署里 API 这一页**连内容都不渲染**，不只是藏起导航按钮——
 * activeTab 跨开关保留，只守按钮就会从上一次的选择漏出来。
 */
export default function SettingsModal() {
  const { t } = useTranslation('settings')
  const { t: tCommon } = useTranslation('common')
  const showSettings = useStore((s) => s.showSettings)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const apiFlushRef = useRef<(() => void) | null>(null)

  if (!showSettings) return null

  const byokEnabled = isByokGenerationEnabled()
  const tabs: Array<{ id: SettingsTab; label: string; Icon: LucideIcon }> = [
    { id: 'general', label: t('tab.general'), Icon: SlidersHorizontal },
    { id: 'data', label: t('tab.data'), Icon: Database },
    ...(byokEnabled ? [{ id: 'api' as const, label: t('tab.api'), Icon: KeyRound }] : []),
  ]

  const handleClose = () => {
    apiFlushRef.current?.()
    setShowSettings(false)
  }

  return (
    <Overlay onClose={handleClose} tier="modal">
      <div className="relative z-10 flex h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-border bg-card/95 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:ring-white/10 sm:h-[600px]">
        <div className="flex shrink-0 items-center justify-between border-b border-border p-5">
          <h3 className="flex items-center gap-2 text-lg font-bold text-foreground">
            <SettingsIcon className="h-5 w-5 text-primary" aria-hidden="true" />
            {t('modal.title')}
          </h3>
          <div className="flex items-center gap-3">
            <span className="select-none font-mono text-sm text-muted-foreground">
              v{__APP_VERSION__}
            </span>
            <button
              type="button"
              onClick={handleClose}
              className="rounded-full p-1 text-muted-foreground transition hover:bg-accent"
              aria-label={tCommon('action.close')}
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav
            aria-label={t('modal.title')}
            className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-card/50 p-3 custom-scrollbar sm:w-48 sm:flex-col sm:overflow-y-auto sm:border-b-0 sm:border-r"
          >
            {tabs.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                aria-current={activeTab === id ? 'page' : undefined}
                className={`flex flex-shrink-0 items-center gap-2.5 whitespace-nowrap rounded-xl px-3 py-2.5 text-sm transition-colors ${
                  activeTab === id
                    ? 'bg-accent font-medium text-primary shadow-sm'
                    : 'text-muted-foreground hover:bg-accent'
                }`}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {label}
              </button>
            ))}
          </nav>

          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto overscroll-contain p-5 custom-scrollbar sm:p-6">
              {activeTab === 'general' && <GeneralTab />}
              {activeTab === 'data' && <DataTab />}
              {activeTab === 'api' && byokEnabled && <ApiTab flushRef={apiFlushRef} />}
            </div>
          </div>
        </div>
      </div>
    </Overlay>
  )
}
