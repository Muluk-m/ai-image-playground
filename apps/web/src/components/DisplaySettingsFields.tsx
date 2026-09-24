import { type AppLocale, SUPPORTED_LOCALES, useTranslation } from '../i18n'
import { useLocalePicker } from '../i18n/useLocalePicker'
import type { ThemeChoice } from '../theme'
import { THEME_LABEL_KEY } from '../theme/labels'
import { useTheme } from '../theme/useTheme'
import { GlobeIcon, MoonIcon, SunIcon } from './icons'
import { SettingRow } from './SettingRow'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

/** 设置面板与头像菜单共用这两个主题选项。 */
const THEME_CHOICES: readonly ThemeChoice[] = ['dark', 'light']

export interface DisplaySettingsFieldsProps {
  /** 行容器 class：宿主菜单的行距与 hover 由宿主给，设置面板用默认值。 */
  rowClassName?: string
  iconClassName?: string
}

/**
 * 显示设置：界面语言与主题。只影响这台设备怎么显示，登录前就生效，不随账号同步。
 */
export default function DisplaySettingsFields({
  rowClassName,
  iconClassName = 'h-[18px] w-[18px]',
}: DisplaySettingsFieldsProps) {
  const { t } = useTranslation('common')
  const { locale, change } = useLocalePicker()
  const { theme, choice, setChoice } = useTheme()
  const ThemeIcon = theme === 'dark' ? MoonIcon : SunIcon

  return (
    <>
      <SettingRow
        className={rowClassName}
        icon={<GlobeIcon className={iconClassName} />}
        label={t('locale.label')}
        control={
          <Select value={locale} onValueChange={(next) => change(next as AppLocale)}>
            {/* 语言名永远用它自己的文字写：看不懂当前界面语言的人靠它认出这一行。 */}
            <SelectTrigger
              aria-label={t('locale.label')}
              data-display-setting="locale"
              lang={locale}
              className="h-8 w-32 text-xs"
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
      <SettingRow
        className={rowClassName}
        icon={<ThemeIcon className={iconClassName} />}
        label={t('theme.label')}
        control={
          <Select value={choice} onValueChange={(next) => setChoice(next as ThemeChoice)}>
            <SelectTrigger
              aria-label={t('theme.label')}
              data-display-setting="theme"
              className="h-8 w-32 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THEME_CHOICES.map((one) => (
                <SelectItem key={one} value={one}>
                  {t(THEME_LABEL_KEY[one])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
    </>
  )
}
