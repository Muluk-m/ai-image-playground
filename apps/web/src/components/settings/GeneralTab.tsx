import { CornerDownLeft, Eraser, RefreshCw, RotateCcw } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useStore } from '../../store'
import { SettingRow } from '../SettingRow'
import { Switch } from '../Switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import SettingsSection from './SettingsSection'

const SUBMIT_WITH_ENTER = 'enter'
const SUBMIT_WITH_MODIFIER = 'ctrl-enter'
const ROW_ICON = 'h-[18px] w-[18px]'
const SECTION_CARD =
  'divide-y divide-border/60 rounded-2xl border border-border bg-card px-4 shadow-sm'

/** 通用：使用习惯（随账号走）。显示设置（语言 / 主题）在头像菜单里，登录前就要能改，不进这里。 */
export default function GeneralTab() {
  const { t } = useTranslation('settings')
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)

  return (
    <div className="space-y-6">
      <SettingsSection title={t('section.behavior')} className={SECTION_CARD}>
        {/* 移动端没有第二种提交键可选。 */}
        <SettingRow
          className="hidden sm:flex"
          icon={<CornerDownLeft className={ROW_ICON} />}
          label={t('general.submitShortcut')}
          hint={
            settings.enterSubmit ? t('general.newlineWithShift') : t('general.newlineWithEnter')
          }
          control={
            <Select
              value={settings.enterSubmit ? SUBMIT_WITH_ENTER : SUBMIT_WITH_MODIFIER}
              onValueChange={(next) => setSettings({ enterSubmit: next === SUBMIT_WITH_ENTER })}
            >
              <SelectTrigger aria-label={t('general.submitShortcut')} className="h-8 w-32 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SUBMIT_WITH_ENTER}>Enter</SelectItem>
                <SelectItem value={SUBMIT_WITH_MODIFIER}>
                  {navigator.userAgent.includes('Mac') ? 'Cmd + Enter' : 'Ctrl + Enter'}
                </SelectItem>
              </SelectContent>
            </Select>
          }
        />
        <SettingRow
          icon={<Eraser className={ROW_ICON} />}
          label={t('general.clearInputAfterSubmit')}
          control={
            <Switch
              checked={settings.clearInputAfterSubmit}
              onChange={(checked) => setSettings({ clearInputAfterSubmit: checked })}
              aria-label={t('general.clearInputAfterSubmit')}
            />
          }
        />
        <SettingRow
          icon={<RotateCcw className={ROW_ICON} />}
          label={t('general.persistInput')}
          control={
            <Switch
              checked={settings.persistInputOnRestart}
              onChange={(checked) => setSettings({ persistInputOnRestart: checked })}
              aria-label={t('general.persistInput')}
            />
          }
        />
        <SettingRow
          icon={<RefreshCw className={ROW_ICON} />}
          label={t('general.alwaysShowRetry')}
          control={
            <Switch
              checked={settings.alwaysShowRetryButton}
              onChange={(checked) => setSettings({ alwaysShowRetryButton: checked })}
              aria-label={t('general.alwaysShowRetry')}
            />
          }
        />
      </SettingsSection>
    </div>
  )
}
