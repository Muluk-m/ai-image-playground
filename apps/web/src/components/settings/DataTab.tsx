import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../auth/AuthContext'
import { useTranslation } from '../../i18n'
import { clearData, exportData, importData, useStore } from '../../store'
import { Checkbox } from '../patterns/Checkbox'
import SyncStatusPanel from '../SyncStatusPanel'
import { Button } from '../ui/button'
import { Icon } from '../ui/icon'
import SettingsSection from './SettingsSection'

const CARD = 'space-y-4 rounded-2xl border border-border bg-card p-4 shadow-sm'
const DANGER_CARD =
  'space-y-4 rounded-2xl border border-destructive/40 bg-destructive/5 p-4 shadow-sm'

/** 数据管理：账号、同步状态，以及导出 / 导入 / 清除。 */
export default function DataTab({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) {
  const { t } = useTranslation(['settings', 'shell'])
  const auth = useAuth()
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const importInputRef = useRef<HTMLInputElement>(null)
  const [exportConfig, setExportConfig] = useState(true)
  const [exportTasks, setExportTasks] = useState(true)
  const [importConfig, setImportConfig] = useState(true)
  const [importTasks, setImportTasks] = useState(true)
  const [clearConfig, setClearConfig] = useState(true)
  const [clearTasks, setClearTasks] = useState(true)
  const [isExportingData, setIsExportingData] = useState(false)
  const [isImportingData, setIsImportingData] = useState(false)
  const [isClearingData, setIsClearingData] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const anyBusy = isExportingData || isImportingData || isClearingData || loggingOut

  useEffect(() => {
    onBusyChange?.(anyBusy)
    return () => onBusyChange?.(false)
  }, [anyBusy, onBusyChange])

  const handleExport = async () => {
    if (anyBusy || (!exportConfig && !exportTasks)) return
    setIsExportingData(true)
    try {
      await exportData({ exportConfig, exportTasks })
    } finally {
      setIsExportingData(false)
    }
  }

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || anyBusy) return
    const opts = { importConfig, importTasks }
    setConfirmDialog({
      title: t('data.importConfirmTitle'),
      message: t('data.importConfirmMessage', { name: file.name }),
      action: async () => {
        setIsImportingData(true)
        try {
          await importData(file, opts)
        } finally {
          setIsImportingData(false)
        }
      },
    })
  }

  const handleLogout = async () => {
    if (anyBusy) return
    setLoggingOut(true)
    try {
      await auth.logout(false)
    } finally {
      setLoggingOut(false)
    }
  }

  return (
    <div className="space-y-6">
      {auth.user ? (
        <SettingsSection
          title={t('section.account')}
          icon={<Icon name="user" size="xs" />}
          className={CARD}
        >
          <div className="flex items-center gap-3">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {auth.user.username}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={anyBusy}
              aria-busy={loggingOut}
              onClick={() => void handleLogout()}
            >
              {loggingOut ? (
                <Icon name="loading" size="xs" className="animate-spin" />
              ) : (
                <Icon name="logout" />
              )}
              {loggingOut ? t('shell:header.loggingOut') : t('shell:logout.title')}
            </Button>
          </div>
        </SettingsSection>
      ) : null}

      <SyncStatusPanel />

      <SettingsSection
        title={t('data.exportTitle')}
        icon={<Icon name="download" size="xs" />}
        className={CARD}
      >
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <Checkbox
            checked={exportConfig}
            onChange={setExportConfig}
            disabled={anyBusy}
            label={t('data.includeConfig')}
          />
          <Checkbox
            checked={exportTasks}
            onChange={setExportTasks}
            disabled={anyBusy}
            label={t('data.includeTasks')}
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          disabled={(!exportConfig && !exportTasks) || anyBusy}
          aria-busy={isExportingData}
          onClick={() => void handleExport()}
        >
          {isExportingData ? <Icon name="loading" className="animate-spin" /> : null}
          {isExportingData ? t('data.exporting') : t('data.exportSelected')}
        </Button>
      </SettingsSection>

      <SettingsSection
        title={t('data.importTitle')}
        icon={<Icon name="upload" size="xs" />}
        className={CARD}
      >
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <Checkbox
            checked={importConfig}
            onChange={setImportConfig}
            disabled={anyBusy}
            label={t('data.includeConfig')}
          />
          <Checkbox
            checked={importTasks}
            onChange={setImportTasks}
            disabled={anyBusy}
            label={t('data.includeTasks')}
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          disabled={(!importConfig && !importTasks) || anyBusy}
          aria-busy={isImportingData}
          onClick={() => importInputRef.current?.click()}
        >
          {isImportingData ? <Icon name="loading" className="animate-spin" /> : null}
          {isImportingData ? t('data.importing') : t('data.importFromZip')}
        </Button>
        <input
          ref={importInputRef}
          type="file"
          accept=".zip"
          className="hidden"
          onChange={handleImport}
        />
      </SettingsSection>

      <SettingsSection
        title={t('data.clearTitle')}
        icon={<Icon name="delete" size="xs" />}
        className={DANGER_CARD}
      >
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <Checkbox
            checked={clearConfig}
            onChange={setClearConfig}
            disabled={anyBusy}
            label={t('data.includeConfig')}
            tone="danger"
          />
          <Checkbox
            checked={clearTasks}
            onChange={setClearTasks}
            disabled={anyBusy}
            label={t('data.includeTasks')}
            tone="danger"
          />
        </div>
        <Button
          type="button"
          variant="destructive"
          className="w-full"
          disabled={(!clearConfig && !clearTasks) || anyBusy}
          aria-busy={isClearingData}
          onClick={() =>
            setConfirmDialog({
              title: t('data.clearSelected'),
              message: t('data.clearMessage'),
              action: async () => {
                setIsClearingData(true)
                try {
                  await clearData({ clearConfig, clearTasks })
                } finally {
                  setIsClearingData(false)
                }
              },
            })
          }
        >
          {isClearingData ? <Icon name="loading" className="animate-spin" /> : null}
          {isClearingData ? t('data.clearing') : t('data.clearSelected')}
        </Button>
      </SettingsSection>
    </div>
  )
}
