import { useRef, useState } from 'react'
import { useTranslation } from '../../i18n'
import { isByokGenerationEnabled } from '../../lib/clientCapabilities'
import { useStore } from '../../store'
import Overlay from '../patterns/Overlay'
import { Button } from '../ui/button'
import { Icon, type IconName } from '../ui/icon'
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
  const tabs: Array<{ id: SettingsTab; label: string; icon: IconName }> = [
    { id: 'general', label: t('tab.general'), icon: 'settingsAdjust' },
    { id: 'data', label: t('tab.data'), icon: 'database' },
    ...(byokEnabled ? [{ id: 'api' as const, label: t('tab.api'), icon: 'key' as const }] : []),
  ]

  const handleClose = () => {
    apiFlushRef.current?.()
    setShowSettings(false)
  }

  return (
    <Overlay onClose={handleClose} tier="modal" label={t('modal.title')}>
      <div className="relative z-10 flex h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-border bg-card/95 shadow-2xl ring-1 ring-hairline animate-modal-in sm:h-[600px]">
        <div className="flex shrink-0 items-center justify-between border-b border-border p-5">
          <h3 className="flex items-center gap-2 text-xl font-semibold text-foreground">
            <Icon name="settings" size="md" className="text-primary" />
            {t('modal.title')}
          </h3>
          <div className="flex items-center gap-3">
            <span className="select-none font-mono text-sm text-muted-foreground">
              v{__APP_VERSION__}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={handleClose}
              className="text-muted-foreground"
              aria-label={tCommon('action.close')}
            >
              <Icon name="close" />
            </Button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav
            aria-label={t('modal.title')}
            className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-card/50 p-3 custom-scrollbar sm:w-48 sm:flex-col sm:overflow-y-auto sm:border-b-0 sm:border-r"
          >
            {tabs.map(({ id, label, icon }) => (
              <Button
                key={id}
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setActiveTab(id)}
                aria-current={activeTab === id ? 'page' : undefined}
                className={`shrink-0 justify-start sm:w-full ${
                  activeTab === id
                    ? 'bg-accent text-primary shadow-sm hover:bg-accent hover:text-primary'
                    : 'text-muted-foreground'
                }`}
              >
                <Icon name={icon} />
                {label}
              </Button>
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
