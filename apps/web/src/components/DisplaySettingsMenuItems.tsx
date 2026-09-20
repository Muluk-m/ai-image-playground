import { SUPPORTED_LOCALES, useTranslation } from '../i18n'
import { useLocalePicker } from '../i18n/useLocalePicker'
import { THEME_LABEL_KEY } from '../theme/labels'
import { useTheme } from '../theme/useTheme'
import { GlobeIcon, MoonIcon, SunIcon } from './icons'

interface DisplaySettingsMenuItemsProps {
  /** 两个头像菜单（公开树与私有 overlay）的行样式不同，由宿主菜单给。 */
  itemClassName: string
  iconClassName: string
}

/**
 * 头像菜单里的显示设置：只影响这台设备怎么显示，登录前就生效，不随账号同步。
 * 点了不关菜单——用户要亲眼看到界面换过去，才知道点对了。
 */
export default function DisplaySettingsMenuItems({
  itemClassName,
  iconClassName,
}: DisplaySettingsMenuItemsProps) {
  const { t } = useTranslation('common')
  const { locale, change } = useLocalePicker()
  const { theme, toggle } = useTheme()
  const next = SUPPORTED_LOCALES[(SUPPORTED_LOCALES.indexOf(locale) + 1) % SUPPORTED_LOCALES.length]
  const ThemeIcon = theme === 'dark' ? MoonIcon : SunIcon

  return (
    <>
      <button
        type="button"
        role="menuitem"
        data-display-setting="locale"
        onClick={() => change(next)}
        aria-label={t('locale.switchAria', {
          current: t(`locale.${locale}`),
          next: t(`locale.${next}`),
        })}
        className={itemClassName}
      >
        <GlobeIcon className={iconClassName} aria-hidden="true" />
        <span>{t('locale.label')}</span>
        {/* 语言名永远用它自己的文字写：看不懂当前界面语言的人靠它认出这一行。 */}
        <span className="ml-auto text-xs text-muted-foreground" lang={locale}>
          {t(`locale.${locale}`)}
        </span>
      </button>
      {/* 一键翻转：固定为当前看到的相反一套。「跟随系统」在设置面板里。 */}
      <button
        type="button"
        role="menuitem"
        data-display-setting="theme"
        onClick={toggle}
        aria-label={t(theme === 'dark' ? 'theme.toLight' : 'theme.toDark')}
        className={itemClassName}
      >
        <ThemeIcon className={iconClassName} aria-hidden="true" />
        <span>{t('theme.label')}</span>
        <span className="ml-auto text-xs text-muted-foreground">{t(THEME_LABEL_KEY[theme])}</span>
      </button>
    </>
  )
}
