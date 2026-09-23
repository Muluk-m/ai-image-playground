import { LoaderCircle, LogOut, UserRound } from 'lucide-react'
import { useRef, useState } from 'react'
import { useAuth } from '../../auth/AuthContext'
import { useTranslation } from '../../i18n'
import { clearData, exportData, importData, useStore } from '../../store'
import { Checkbox } from '../Checkbox'
import { ExportIcon, ImportIcon, TrashIcon } from '../icons'
import LogoutDialog from '../LogoutDialog'
import SyncStatusPanel from '../SyncStatusPanel'
import { Button } from '../ui/button'
import SettingsSection from './SettingsSection'

const SECTION_ICON = 'h-3.5 w-3.5'
const CARD = 'space-y-4 rounded-2xl border border-border bg-card p-4 shadow-sm'
const DANGER_CARD =
  'space-y-4 rounded-2xl border border-destructive/40 bg-destructive/5 p-4 shadow-sm'

/** 数据管理：账号、同步状态，以及导出 / 导入 / 清除。 */
export default function DataTab() {
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
  const [isImportingData, setIsImportingData] = useState(false)
  const [logoutOpen, setLogoutOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setIsImportingData(true)
      try {
        await importData(file, { importConfig, importTasks })
      } finally {
        setIsImportingData(false)
      }
    }
    e.target.value = ''
  }

  return (
    <div className="space-y-6">
      {auth.user ? (
        <SettingsSection
          title={t('section.account')}
          icon={<UserRound className={SECTION_ICON} />}
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
              disabled={loggingOut}
              onClick={() => setLogoutOpen(true)}
            >
              <LogOut />
              {loggingOut ? t('shell:header.loggingOut') : t('shell:logout.title')}
            </Button>
          </div>
        </SettingsSection>
      ) : null}

      <SyncStatusPanel />

      <SettingsSection
        title={t('data.exportTitle')}
        icon={<ExportIcon className={SECTION_ICON} />}
        className={CARD}
      >
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <Checkbox
            checked={exportConfig}
            onChange={setExportConfig}
            label={t('data.includeConfig')}
          />
          <Checkbox
            checked={exportTasks}
            onChange={setExportTasks}
            label={t('data.includeTasks')}
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          disabled={!exportConfig && !exportTasks}
          onClick={() => exportData({ exportConfig, exportTasks })}
        >
          {t('data.exportSelected')}
        </Button>
      </SettingsSection>

      <SettingsSection
        title={t('data.importTitle')}
        icon={<ImportIcon className={SECTION_ICON} />}
        className={CARD}
      >
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <Checkbox
            checked={importConfig}
            onChange={setImportConfig}
            label={t('data.includeConfig')}
          />
          <Checkbox
            checked={importTasks}
            onChange={setImportTasks}
            label={t('data.includeTasks')}
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          disabled={(!importConfig && !importTasks) || isImportingData}
          onClick={() => importInputRef.current?.click()}
        >
          {isImportingData ? <LoaderCircle className="animate-spin" /> : null}
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
        icon={<TrashIcon className={SECTION_ICON} />}
        className={DANGER_CARD}
      >
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <Checkbox
            checked={clearConfig}
            onChange={setClearConfig}
            label={t('data.includeConfig')}
            tone="danger"
          />
          <Checkbox
            checked={clearTasks}
            onChange={setClearTasks}
            label={t('data.includeTasks')}
            tone="danger"
          />
        </div>
        <Button
          type="button"
          variant="destructive"
          className="w-full"
          disabled={!clearConfig && !clearTasks}
          onClick={() =>
            setConfirmDialog({
              title: t('data.clearSelected'),
              message: t('data.clearMessage'),
              action: () => clearData({ clearConfig, clearTasks }),
            })
          }
        >
          {t('data.clearSelected')}
        </Button>
      </SettingsSection>

      {logoutOpen && (
        <LogoutDialog
          onCancel={() => setLogoutOpen(false)}
          onConfirm={(clearLocalData) => {
            setLogoutOpen(false)
            setLoggingOut(true)
            void auth.logout(clearLocalData)
          }}
        />
      )}
    </div>
  )
}
