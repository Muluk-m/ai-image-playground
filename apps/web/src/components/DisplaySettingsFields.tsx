import { type AppLocale, SUPPORTED_LOCALES, useTranslation } from '../i18n'
import { useLocalePicker } from '../i18n/useLocalePicker'
import type { ThemeChoice } from '../theme'
import { useTheme } from '../theme/useTheme'
import { SettingRow } from './patterns/SettingRow'
import ThemeSwitch from './ThemeSwitch'
import { Icon, type IconName } from './ui/icon'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

export interface DisplaySettingsFieldsProps {
  /** 行容器 class：宿主菜单的行距与 hover 由宿主给，设置面板用默认值。 */
  rowClassName?: string
  iconClassName?: string
  /**
   * 语言行。头像菜单不放：界面语言只在顶栏地球。
   * 要下拉的地方显式打开，不要再用 CSS 把这一行藏掉。
   */
  showLanguage?: boolean
  /** 主题行。菜单里是三段图标开关。 */
  showTheme?: boolean
}

function themeRowIcon(choice: ThemeChoice): IconName {
  if (choice === 'light') return 'light'
  if (choice === 'system') return 'system'
  return 'dark'
}

/**
 * 显示设置。语言和主题都只影响这台设备，登录前就生效，不随账号同步。
 * 显示哪几行由 props 决定，菜单默认只有主题。
 */
export default function DisplaySettingsFields({
  rowClassName,
  iconClassName = 'h-4 w-4',
  showLanguage = false,
  showTheme = true,
}: DisplaySettingsFieldsProps) {
  const { t } = useTranslation('common')
  const { locale, change } = useLocalePicker()
  const { choice } = useTheme()

  return (
    <>
      {showLanguage ? (
        <SettingRow
          className={rowClassName}
          icon={<Icon name="language" className={iconClassName} />}
          label={t('locale.label')}
          control={
            <Select value={locale} onValueChange={(next) => change(next as AppLocale)}>
              {/* 语言名永远用它自己的文字写：看不懂当前界面语言的人靠它认出这一行。 */}
              <SelectTrigger
                aria-label={t('locale.label')}
                data-display-setting="locale"
                lang={locale}
                className="h-8 w-32 text-sm"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SUPPORTED_LOCALES.map((one) => (
                  <SelectItem key={one} value={one} lang={one} data-locale={one}>
                    {t(`locale.${one}` as const)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      ) : null}
      {showTheme ? (
        <SettingRow
          className={rowClassName}
          icon={<Icon name={themeRowIcon(choice)} className={iconClassName} />}
          label={t('theme.label')}
          control={<ThemeSwitch />}
        />
      ) : null}
    </>
  )
}
